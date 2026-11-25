import type { FailedDelivery } from "@wheatley-ai/protocol";
import { isDeliveryError } from "@wheatley-ai/sdk";
import type { Delivery } from "@wheatley-ai/sdk";

import type {
  DeliveryOutbox,
  DeliveryOutboxDeps,
  OutboxEntry,
  OutboxItem,
} from "./delivery-outbox.js";
import { simulateIo } from "./fake-io.js";
import { systemClock } from "./module.js";
import type { Clock, EventSink } from "./module.js";

/** The attempt limit of the real outbox. */
export const MAX_DELIVERY_ATTEMPTS = 10;

const PREVIEW_LENGTH = 500;

const previewOf = (delivery: Delivery): string => {
  const text =
    delivery.kind === "message"
      ? delivery.text
      : `${delivery.kind} ${delivery.approvalId}`;

  return text.slice(0, PREVIEW_LENGTH);
};

const errorText = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** Options of the fake outbox. */
export interface FakeDeliveryOutboxOptions {
  readonly clock?: Clock;
  readonly events?: EventSink;
}

/**
 * An in-memory `DeliveryOutbox`. It has no timers: `drain()` makes one delivery attempt per due entry, in FIFO order
 * per Chat, and ignores backoff delays.
 */
export class InMemoryDeliveryOutbox implements DeliveryOutbox {
  readonly #agentName: string;
  readonly #deps: DeliveryOutboxDeps;
  readonly #clock: Clock;
  readonly #emitter: EventSink | undefined;
  readonly #entries: OutboxEntry[] = [];
  readonly #copyErrors: unknown[] = [];
  #nextId = 1;

  constructor(
    agentName: string,
    deps: DeliveryOutboxDeps,
    options: FakeDeliveryOutboxOptions = {}
  ) {
    this.#agentName = agentName;
    this.#deps = deps;
    this.#clock = options.clock ?? systemClock;
    this.#emitter = options.events;
  }

  /** Rejections of `onDelivered`, which the real outbox logs. */
  get copyErrors(): readonly unknown[] {
    return this.#copyErrors;
  }

  /** Every entry in creation order, for test assertions. */
  get entries(): readonly OutboxEntry[] {
    return this.#entries;
  }

  readonly enqueue = async (item: OutboxItem): Promise<OutboxEntry> => {
    await simulateIo();
    const deliveryId = `delivery-${this.#nextId}`;
    this.#nextId += 1;

    const entry: OutboxEntry = {
      attempts: 0,
      bindingId: item.bindingId,
      chatId: item.chatId,
      createdAt: this.#clock.now(),
      delivery: {
        ...item.delivery,
        chatId: item.chatId,
        messageId: deliveryId,
      },
      deliveryId,
      lastError: null,
      nextAttemptAt: this.#clock.now(),
      permanent: false,
      sourceConversationId: item.sourceConversationId,
      status: "pending",
    };

    this.#entries.push(entry);

    return entry;
  };

  readonly listFailed = async (): Promise<readonly FailedDelivery[]> => {
    await simulateIo();

    return this.#entries
      .filter((entry) => entry.status === "failed")
      .map((entry) => this.#failedDelivery(entry));
  };

  readonly retry = async (deliveryId: string): Promise<boolean> =>
    await this.#leaveFailed(deliveryId, "retried", {
      attempts: 0,
      permanent: false,
      status: "pending",
    });

  readonly dismiss = async (deliveryId: string): Promise<boolean> =>
    await this.#leaveFailed(deliveryId, "dismissed", { status: "dismissed" });

  /** Makes one attempt for the oldest pending entry of each Chat. Resolves with the number of confirmed deliveries. */
  readonly drain = async (): Promise<number> => {
    const blocked = new Set<string>();
    let delivered = 0;

    for (const [index, entry] of this.#entries.entries()) {
      const chat = `${entry.bindingId}\u0000${entry.chatId}`;

      if (entry.status !== "pending" || blocked.has(chat)) {
        continue;
      }

      blocked.add(chat);
      // oxlint-disable-next-line no-await-in-loop -- FIFO order per Chat requires one attempt at a time.
      const next = await this.#attempt(entry);
      this.#entries[index] = next;

      if (next.status === "failed") {
        this.#emitter?.emit("delivery.failed", {
          agent: this.#agentName,
          delivery: this.#failedDelivery(next),
        });
      }

      if (next.status === "delivered") {
        delivered += 1;
        blocked.delete(chat);
        // oxlint-disable-next-line no-await-in-loop -- The copy follows its own confirmed delivery.
        await this.#copy(next);
      }
    }

    return delivered;
  };

  readonly #copy = async (entry: OutboxEntry): Promise<void> => {
    if (entry.sourceConversationId === undefined) {
      return;
    }

    try {
      await this.#deps.onDelivered(entry);
    } catch (error) {
      this.#copyErrors.push(error);
    }
  };

  readonly #failedDelivery = (entry: OutboxEntry): FailedDelivery => ({
    agent: this.#agentName,
    attempts: entry.attempts,
    bindingId: entry.bindingId,
    chatId: entry.chatId,
    createdAt: new Date(entry.createdAt).toISOString(),
    deliveryId: entry.deliveryId,
    failedAt: new Date(this.#clock.now()).toISOString(),
    kind: entry.delivery.kind,
    lastError: entry.lastError ?? "",
    permanent: entry.permanent,
    preview: previewOf(entry.delivery),
  });

  readonly #attempt = async (entry: OutboxEntry): Promise<OutboxEntry> => {
    const attempts = entry.attempts + 1;

    try {
      await this.#deps.deliver(entry.bindingId, entry.delivery);

      return { ...entry, attempts, nextAttemptAt: null, status: "delivered" };
    } catch (error) {
      const permanent = isDeliveryError(error) && error.kind === "permanent";
      const failed = permanent || attempts >= MAX_DELIVERY_ATTEMPTS;

      return {
        ...entry,
        attempts,
        lastError: errorText(error),
        nextAttemptAt: failed ? null : this.#clock.now(),
        permanent,
        status: failed ? "failed" : "pending",
      };
    }
  };

  readonly #leaveFailed = async (
    deliveryId: string,
    reason: "retried" | "dismissed",
    change: Partial<Pick<OutboxEntry, "attempts" | "permanent" | "status">>
  ): Promise<boolean> => {
    await simulateIo();

    const index = this.#entries.findIndex(
      (entry) => entry.deliveryId === deliveryId
    );

    const entry = this.#entries[index];

    if (entry?.status !== "failed") {
      return false;
    }

    this.#entries[index] = {
      ...entry,
      ...change,
      nextAttemptAt: this.#clock.now(),
    };
    this.#emitter?.emit("delivery.cleared", {
      agent: this.#agentName,
      deliveryId,
      reason,
    });

    return true;
  };
}
