import { randomUUID } from "node:crypto";

import type {
  ApprovalOutcome,
  PendingApproval,
  PermissionRule,
} from "@wheatley/protocol";
import type { ApprovalResolution } from "@wheatley/sdk";

import type {
  ApprovalGate,
  ApprovalGateDeps,
  DecisionOrigin,
  DenyReason,
  GatedToolCall,
  GateVerdict,
} from "../contracts/approval-gate.js";
import type { OutboxItem } from "../contracts/delivery-outbox.js";
import type { AgentModuleContext } from "../contracts/module.js";
import { policyAction } from "./policy.js";
import { buildInputPreview } from "./preview.js";
import { createApprovalStore, toPendingApproval } from "./store.js";
import type { StoredApproval, StoredResolution } from "./store.js";

/** The parts of the module context that the gate uses. */
export type ApprovalGateContext = Pick<
  AgentModuleContext,
  "agentName" | "clock" | "db" | "events" | "log"
>;

/** A new Approval and the `wait` verdict of the call that opened it. */
interface OpenedApproval {
  readonly approval: StoredApproval;
  readonly verdict: GateVerdict;
}

/** An Approval that this gate resolved and must still announce. */
interface Claim {
  readonly approval: StoredApproval;
  readonly resolution: StoredResolution;
}

const ALLOW_OUTCOMES: ReadonlySet<ApprovalOutcome> = new Set([
  "allow_once",
  "allow_conversation",
  "allow_always",
]);

const signalKeyOf = (callKey: string, approvalId: string): string =>
  `${callKey}:${approvalId}`;

const denial = (reason: DenyReason, message: string): GateVerdict => ({
  kind: "deny",
  message,
  reason,
});

const sameRule = (left: PermissionRule | undefined, right: PermissionRule) =>
  left?.action === right.action && left.tool === right.tool;

const isFromOriginatingChat = (
  origin: DecisionOrigin,
  approval: StoredApproval
): boolean =>
  origin.kind === "operator" ||
  (approval.chat !== null &&
    origin.bindingId === approval.chat.bindingId &&
    origin.chatId === approval.chat.chatId);

const stoppedMessage = (toolName: string): string =>
  `The Run stopped before a decision on ${toolName}`;

/**
 * The verdict for a call from the outcome of its own Approval. An allow outcome returns `allow`. `deny` and `cancelled`
 * return `deny` with that reason. Every other outcome, including `null`, returns `deny` (`timeout`).
 */
const verdictForOutcome = (approval: StoredApproval): GateVerdict => {
  const { outcome, reason, toolName } = approval;

  if (outcome !== null && ALLOW_OUTCOMES.has(outcome)) {
    return { kind: "allow" };
  }

  if (outcome === "deny") {
    const suffix = reason === null ? "" : `: ${reason}`;

    return denial(
      "decision",
      `The Approval for ${toolName} was denied${suffix}`
    );
  }

  return outcome === "cancelled"
    ? denial("cancelled", stoppedMessage(toolName))
    : denial(
        "timeout",
        `No decision on ${toolName} before the Approval timed out`
      );
};

/**
 * Creates the `ApprovalGate` of one Agent on `agent.sqlite` (ADR 0011). It follows the `check` order and the `decide`
 * steps of the `ApprovalGate` contract.
 *
 * Invariants:
 * - Every read and write that decides a verdict or claims an Approval runs synchronously, before the first `await`.
 *   Thus two concurrent `check` calls of one Run cannot both open an Approval, and two concurrent decisions cannot both
 *   win.
 * - The live Permission Policy starts as `deps.policy`. An `allow_always` decision prepends an exact-tool `allow` rule
 *   to it before the first `await`, so a call that the decision wakes sees the rule.
 * - A wake never names the call that runs `check`, because that call is not parked.
 * - After `cancelRun`, a call that waited on a cancelled Approval gets `deny` (`cancelled`) at its next `check`. It does
 *   not open an Approval of its own.
 *
 * Errors:
 * - If `outbox.enqueue` fails, the gate logs the error and continues with the event and the wake.
 * - If `config.prependPermissionRule` fails, the gate keeps the rule in the live policy, completes the event and the
 *   wake, and then rejects `decide`. The rule ends when the Agent restarts.
 * - A failed `deps.wake` rejects the gate method. The decision stays stored, and the parked call sees it at its next
 *   `check`.
 */
export const createApprovalGate = (
  ctx: ApprovalGateContext,
  deps: ApprovalGateDeps
): ApprovalGate => {
  const { agentName, clock, events, log } = ctx;
  const store = createApprovalStore(ctx.db);
  const rules: PermissionRule[] = [...deps.policy];

  const isExpired = (approval: StoredApproval): boolean =>
    approval.expiresAt !== null && clock.now() >= approval.expiresAt;

  /** Claims a pending Approval. Returns the claim to announce, or `undefined` if another caller resolved it first. */
  const claim = (
    approval: StoredApproval,
    outcome: ApprovalOutcome,
    resolution?: Pick<ApprovalResolution, "reason" | "resolvedBy">
  ): Claim | undefined => {
    const stored: StoredResolution = {
      outcome,
      reason: resolution?.reason,
      resolvedAt: clock.now(),
      resolvedBy: resolution?.resolvedBy,
    };

    return store.resolve(approval.approvalId, stored)
      ? { approval, resolution: stored }
      : undefined;
  };

  /** Claims each Approval with `outcome` and returns the claims that this gate won. */
  const claimEach = (
    approvals: readonly StoredApproval[],
    outcome: ApprovalOutcome
  ): Claim[] => approvals.flatMap((approval) => claim(approval, outcome) ?? []);

  /** Enqueues a delivery for the Chat of the Approval. If the enqueue fails, the gate logs the error and continues. */
  const enqueueFor = async (
    { approvalId, chat }: Pick<StoredApproval, "approvalId" | "chat">,
    delivery: OutboxItem["delivery"]
  ): Promise<void> => {
    if (chat === null) {
      return;
    }

    try {
      await deps.outbox.enqueue({ ...chat, delivery });
    } catch (error) {
      log.error(`Could not enqueue ${delivery.kind}`, {
        approvalId,
        error: String(error),
      });
    }
  };

  /** Enqueues `approval_resolved`, emits `approval.resolved`, and wakes every parked call except `runningCallKey`. */
  const announce = async (
    { approval, resolution }: Claim,
    runningCallKey?: string
  ): Promise<void> => {
    const { approvalId } = approval;
    const { outcome, reason, resolvedBy } = resolution;

    await enqueueFor(approval, {
      approvalId,
      decision: outcome,
      kind: "approval_resolved",
      reason,
      resolvedBy,
    });

    events.emit("approval.resolved", {
      agent: agentName,
      approvalId,
      decision: outcome,
      reason,
      resolvedBy,
    });

    const parked = store
      .waiters(approvalId)
      .filter(({ callKey }) => callKey !== runningCallKey);

    if (parked.length > 0) {
      await deps.wake(parked);
    }
  };

  const announceAll = async (
    claims: readonly Claim[],
    runningCallKey?: string
  ): Promise<void> => {
    for (const item of claims) {
      // oxlint-disable-next-line no-await-in-loop -- Resolutions reach each Chat in the order the gate stored them.
      await announce(item, runningCallKey);
    }
  };

  const park = (approval: StoredApproval, callKey: string): GateVerdict => {
    const signalKey = signalKeyOf(callKey, approval.approvalId);
    store.addWaiter(approval.approvalId, { callKey, signalKey });

    return {
      approvalId: approval.approvalId,
      expiresAt: approval.expiresAt,
      kind: "wait",
      signalKey,
    };
  };

  /** Times out every expired pending Approval in `pending` and returns the claims. */
  const expire = (pending: readonly StoredApproval[]): Claim[] =>
    claimEach(pending.filter(isExpired), "timeout");

  /** Stores a new Approval for `call` and parks the call on it. */
  const open = (call: GatedToolCall): OpenedApproval => {
    const now = clock.now();

    const approval: StoredApproval = {
      approvalId: randomUUID(),
      callKey: call.callKey,
      chat: call.chat,
      conversationId: call.conversationId,
      createdAt: now,
      expiresAt: deps.timeoutMs === null ? null : now + deps.timeoutMs,
      inputPreview: buildInputPreview(call.input, deps.secrets),
      outcome: null,
      reason: null,
      resolvedBy: null,
      runId: call.runId,
      toolName: call.toolName,
    };

    store.insert(approval);

    return { approval, verdict: park(approval, call.callKey) };
  };

  /** Enqueues `approval_requested` and emits `approval.requested`. */
  const request = async (approval: PendingApproval): Promise<void> => {
    await enqueueFor(approval, {
      approvalId: approval.approvalId,
      expiresAt: approval.expiresAt,
      inputPreview: approval.inputPreview,
      kind: "approval_requested",
      runId: approval.runId,
      toolName: approval.toolName,
    });

    events.emit("approval.requested", { agent: agentName, approval });
  };

  /** Steps 5 and 6: the call already has its own Approval. */
  const checkOwn = async (
    own: StoredApproval,
    callKey: string
  ): Promise<GateVerdict> => {
    if (own.outcome !== null) {
      return verdictForOutcome(own);
    }

    if (!isExpired(own)) {
      return park(own, callKey);
    }

    const claims = claimEach([own], "timeout");
    const current = store.byId(own.approvalId) ?? own;
    await announceAll(claims, callKey);

    return verdictForOutcome(current);
  };

  /** Steps 7 and 8: wait on the Run's pending Approval, or open the call's own Approval. */
  const checkRun = async (call: GatedToolCall): Promise<GateVerdict> => {
    const expired = expire(store.pending(call.runId));
    const blocking = store.oldestPendingInRun(call.runId);

    if (blocking !== undefined) {
      const verdict = park(blocking, call.callKey);
      await announceAll(expired, call.callKey);

      return verdict;
    }

    const { approval, verdict } = open(call);
    await announceAll(expired, call.callKey);
    await request(toPendingApproval(agentName, approval));

    return verdict;
  };

  const check = async (call: GatedToolCall): Promise<GateVerdict> => {
    const action = policyAction(rules, call.toolName, deps.defaultAction);

    if (action === "deny") {
      return denial("policy", `The Permission Policy denies ${call.toolName}`);
    }

    if (
      action === "allow" ||
      store.hasGrant(call.conversationId, call.toolName)
    ) {
      return { kind: "allow" };
    }

    if (!call.interactive) {
      return denial(
        "non_interactive",
        `${call.toolName} needs an Approval, and this Run cannot ask for one`
      );
    }

    const own = store.byCallKey(call.callKey);

    if (own !== undefined) {
      return await checkOwn(own, call.callKey);
    }

    if (store.waitedOnCancelled(call.callKey)) {
      return denial("cancelled", stoppedMessage(call.toolName));
    }

    return await checkRun(call);
  };

  /**
   * Prepends an exact-tool `allow` rule to the live policy, then saves it to `config.yaml`. Resolves with an `Error` if
   * the save fails, so that `decide` can complete the wake before it rejects.
   */
  const applyAllowAlways = async (
    toolName: string
  ): Promise<Error | undefined> => {
    const rule: PermissionRule = { action: "allow", tool: toolName };

    if (!sameRule(rules[0], rule)) {
      rules.unshift(rule);
    }

    try {
      await deps.config.prependPermissionRule(agentName, rule);

      return undefined;
    } catch (error) {
      return new Error(
        `config.yaml did not save the allow_always rule for ${toolName}. The rule applies until the Agent restarts.`,
        { cause: error }
      );
    }
  };

  const decide = async (
    approvalId: string,
    resolution: ApprovalResolution,
    origin: DecisionOrigin
  ): Promise<boolean> => {
    const approval = store.byId(approvalId);

    if (
      approval === undefined ||
      approval.outcome !== null ||
      !isFromOriginatingChat(origin, approval)
    ) {
      return false;
    }

    if (isExpired(approval)) {
      await announceAll(expire([approval]));

      return false;
    }

    const claimed = claim(approval, resolution.decision, resolution);

    if (claimed === undefined) {
      return false;
    }

    if (resolution.decision === "allow_conversation") {
      store.addGrant(
        approval.conversationId,
        approval.toolName,
        claimed.resolution.resolvedAt
      );
    }

    const saveError =
      resolution.decision === "allow_always"
        ? await applyAllowAlways(approval.toolName)
        : undefined;

    await announce(claimed);

    if (saveError !== undefined) {
      throw saveError;
    }

    return true;
  };

  const cancelRun = async (runId: string): Promise<number> => {
    const cancelled = claimEach(store.pending(runId), "cancelled");

    await announceAll(cancelled);

    return cancelled.length;
  };

  const clearConversationGrants = async (
    conversationId: string
  ): Promise<void> => {
    store.clearGrants(conversationId);
    // The seam is async, but node:sqlite writes synchronously. Lint requires both `async` and an `await` here.
    await Promise.resolve();
  };

  const listPending = async (): Promise<readonly PendingApproval[]> => {
    await announceAll(expire(store.pending()));

    return store
      .pending()
      .map((approval) => toPendingApproval(agentName, approval));
  };

  return { cancelRun, check, clearConversationGrants, decide, listPending };
};
