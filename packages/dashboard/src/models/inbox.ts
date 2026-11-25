import { RpcError, RpcErrorCode } from "@wheatley/protocol";
import type {
  ApprovalDecision,
  ApprovalResolution,
  ChatKey,
  FailedDelivery,
  PendingApproval,
} from "@wheatley/protocol";

import type { RpcClient } from "../rpc/client.js";
import { createStore, errorMessage, withEntry, withMember } from "../store.js";
import type { Store } from "../store.js";
import { disposeAll, loadOnReady } from "./lifecycle.js";

/** The Inbox: pending Approvals and failed deliveries of every Agent. */
export interface InboxState {
  readonly loading: boolean;
  /** The last load error, or `null`. */
  readonly error: string | null;
  /** Pending Approvals, oldest first. */
  readonly approvals: readonly PendingApproval[];
  /** Failed deliveries, newest failure first. */
  readonly deliveries: readonly FailedDelivery[];
  /** Keys of items with a request in flight. See `approvalKey` and `deliveryKey`. */
  readonly busy: ReadonlySet<string>;
  /** The last failed request of each item that is still in the Inbox, by key. */
  readonly itemErrors: ReadonlyMap<string, string>;
  /** A message about an item that left the Inbox without the Operator's action, for example a lost decision. */
  readonly notice: string | null;
}

/** The Inbox model. It follows `approval.*` and `delivery.*` events and reloads after each reconnect. */
export interface Inbox {
  readonly state: Store<InboxState>;
  /** Loads both lists again. */
  readonly refresh: () => Promise<void>;
  /**
   * Sends the Operator's decision on an Approval. The first decision of any client wins (ADR 0005): if another client
   * or a timeout won, the Approval leaves the Inbox and `notice` says so. If the request fails, the Approval stays and
   * its item error holds the reason. Never rejects.
   */
  readonly decide: (
    approval: PendingApproval,
    decision: ApprovalDecision,
    reason?: string
  ) => Promise<void>;
  /**
   * Puts a failed delivery back into the outbox. If the delivery no longer exists, it leaves the Inbox and `notice`
   * says so. If the request fails otherwise, the item error holds the reason. Never rejects.
   */
  readonly retry: (delivery: FailedDelivery) => Promise<void>;
  /** Removes a failed delivery without sending it. Failures behave as in `retry`. Never rejects. */
  readonly dismiss: (delivery: FailedDelivery) => Promise<void>;
  /** Removes the event listeners. */
  readonly dispose: () => void;
}

/** The name that the Inbox records as `resolvedBy` on Operator decisions. */
export const OPERATOR_DISPLAY_NAME = "Operator (dashboard)";

/** The key of an Approval in `busy` and `itemErrors`. */
export const approvalKey = (approval: {
  readonly agent: string;
  readonly approvalId: string;
}): string => `approval:${approval.agent}:${approval.approvalId}`;

/** The key of a failed delivery in `busy` and `itemErrors`. */
export const deliveryKey = (delivery: {
  readonly agent: string;
  readonly deliveryId: string;
}): string => `delivery:${delivery.agent}:${delivery.deliveryId}`;

/** Returns the pending Approvals of the Runs in `chat` of `agent`, oldest first. */
export const chatApprovals = (
  state: InboxState,
  agent: string,
  chat: ChatKey
): readonly PendingApproval[] =>
  state.approvals.filter(
    (approval) =>
      approval.agent === agent &&
      approval.chat?.bindingId === chat.bindingId &&
      approval.chat.chatId === chat.chatId
  );

const byCreatedAt = (left: PendingApproval, right: PendingApproval): number =>
  left.createdAt.localeCompare(right.createdAt);

const byFailedAtDescending = (
  left: FailedDelivery,
  right: FailedDelivery
): number => right.failedAt.localeCompare(left.failedAt);

const isNotFound = (cause: unknown): boolean =>
  cause instanceof RpcError && cause.code === RpcErrorCode.NotFound;

/** Creates the Inbox model and loads it once the client is ready. */
export const createInbox = (client: RpcClient): Inbox => {
  const state = createStore<InboxState>({
    approvals: [],
    busy: new Set(),
    deliveries: [],
    error: null,
    itemErrors: new Map(),
    loading: true,
    notice: null,
  });

  const removeApproval = (agent: string, approvalId: string): void => {
    state.update((current) => ({
      ...current,
      approvals: current.approvals.filter(
        (entry) => entry.agent !== agent || entry.approvalId !== approvalId
      ),
    }));
  };

  const removeDelivery = (agent: string, deliveryId: string): void => {
    state.update((current) => ({
      ...current,
      deliveries: current.deliveries.filter(
        (entry) => entry.agent !== agent || entry.deliveryId !== deliveryId
      ),
    }));
  };

  const setItem = (key: string, busy: boolean, error?: string): void => {
    state.update((current) => ({
      ...current,
      busy: withMember(current.busy, key, busy),
      itemErrors: withEntry(current.itemErrors, key, error),
    }));
  };

  const refresh = async (): Promise<void> => {
    state.update((current) => ({ ...current, loading: true }));

    try {
      const [{ approvals }, { deliveries }] = await Promise.all([
        client.call("approvals.list", {}),
        client.call("deliveries.listFailed", {}),
      ]);

      state.update((current) => ({
        ...current,
        approvals: approvals.toSorted(byCreatedAt),
        deliveries: deliveries.toSorted(byFailedAtDescending),
        error: null,
        loading: false,
      }));
    } catch (error) {
      state.update((current) => ({
        ...current,
        error: errorMessage(error),
        loading: false,
      }));
    }
  };

  /**
   * Runs one item action and marks the item busy meanwhile. The action returns a notice for an item that left the
   * Inbox without the Operator's action, or `null`. A thrown error becomes the item error.
   */
  const runItem = async (
    key: string,
    action: () => Promise<string | null>
  ): Promise<void> => {
    setItem(key, true);
    state.update((current) => ({ ...current, notice: null }));

    try {
      const notice = await action();

      setItem(key, false);
      state.update((current) => ({ ...current, notice }));
    } catch (error) {
      setItem(key, false, errorMessage(error));
    }
  };

  const dispose = disposeAll([
    loadOnReady(client, () => {
      void refresh();
    }),
    client.on("approval.requested", ({ approval }) => {
      state.update((current) => ({
        ...current,
        approvals: [
          ...current.approvals.filter(
            (entry) => approvalKey(entry) !== approvalKey(approval)
          ),
          approval,
        ].toSorted(byCreatedAt),
      }));
    }),
    client.on("approval.resolved", ({ agent, approvalId }) => {
      removeApproval(agent, approvalId);
    }),
    client.on("delivery.failed", ({ delivery }) => {
      state.update((current) => ({
        ...current,
        deliveries: [
          ...current.deliveries.filter(
            (entry) => deliveryKey(entry) !== deliveryKey(delivery)
          ),
          delivery,
        ].toSorted(byFailedAtDescending),
      }));
    }),
    client.on("delivery.cleared", ({ agent, deliveryId }) => {
      removeDelivery(agent, deliveryId);
    }),
  ]);

  return {
    decide: async (approval, decision, reason) => {
      await runItem(approvalKey(approval), async () => {
        const resolution: ApprovalResolution = {
          decision,
          resolvedBy: OPERATOR_DISPLAY_NAME,
        };

        if (reason !== undefined && reason !== "") {
          resolution.reason = reason;
        }

        const { accepted } = await client.call("approvals.decide", {
          agent: approval.agent,
          approvalId: approval.approvalId,
          resolution,
        });

        removeApproval(approval.agent, approval.approvalId);

        return accepted
          ? null
          : "Another client decided first, or the Approval ended.";
      });
    },
    dismiss: async (delivery) => {
      await runItem(deliveryKey(delivery), async () => {
        const { dismissed } = await client.call("deliveries.dismiss", {
          agent: delivery.agent,
          deliveryId: delivery.deliveryId,
        });

        removeDelivery(delivery.agent, delivery.deliveryId);

        return dismissed ? null : "The delivery had already left the outbox.";
      });
    },
    dispose,
    refresh,
    retry: async (delivery) => {
      await runItem(deliveryKey(delivery), async () => {
        try {
          const { requeued } = await client.call("deliveries.retry", {
            agent: delivery.agent,
            deliveryId: delivery.deliveryId,
          });

          if (!requeued) {
            throw new Error("The outbox did not take the delivery back.");
          }
        } catch (error) {
          if (!isNotFound(error)) {
            throw error;
          }

          removeDelivery(delivery.agent, delivery.deliveryId);

          return "The delivery had already left the outbox.";
        }

        removeDelivery(delivery.agent, delivery.deliveryId);

        return null;
      });
    },
    state,
  };
};
