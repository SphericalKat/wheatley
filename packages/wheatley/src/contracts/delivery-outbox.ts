import type { FailedDelivery } from "@wheatley/protocol";
import type { Delivery } from "@wheatley/sdk";

/** A `Delivery` before the outbox assigns `messageId` and `chatId`. */
export type DeliveryDraft = Delivery extends infer Item
  ? Item extends Delivery
    ? Omit<Item, "messageId" | "chatId">
    : never
  : never;

/** One item to deliver to one Chat. */
export interface OutboxItem {
  readonly bindingId: string;
  readonly chatId: string;
  readonly delivery: DeliveryDraft;
  /**
   * For Trigger results: the Conversation that produced the item. On confirmed delivery, the outbox calls
   * `DeliveryOutboxDeps.onDelivered`, which copies the result into the target Chat's current Conversation (ADR 0010).
   */
  readonly sourceConversationId?: string;
}

/** The state of an outbox entry. */
export type OutboxStatus = "pending" | "delivered" | "failed" | "dismissed";

/** One stored outbox entry. */
export interface OutboxEntry {
  /** Also the `messageId` of the delivered `Delivery`. */
  readonly deliveryId: string;
  readonly bindingId: string;
  readonly chatId: string;
  readonly delivery: Delivery;
  readonly sourceConversationId: string | undefined;
  readonly status: OutboxStatus;
  readonly attempts: number;
  /** Epoch milliseconds of the next attempt, or `null` if the outbox schedules no further attempt. */
  readonly nextAttemptAt: number | null;
  readonly lastError: string | null;
  /** True if the last failure was a permanent `DeliveryError`. */
  readonly permanent: boolean;
  /** Epoch milliseconds. */
  readonly createdAt: number;
}

/**
 * The durable, at-least-once outbox of one Agent in `agent.sqlite` (ADR 0007, ADR 0010).
 *
 * Invariants:
 * - Order is FIFO per `(bindingId, chatId)`. A `failed` or `dismissed` entry no longer blocks newer entries.
 * - A permanent `DeliveryError` fails the entry at once and emits `delivery.failed`.
 * - A retryable error retries with exponential backoff and jitter, and honors `retryAfterMs`. Any other error counts
 *   as retryable. Retries stop after 10 attempts or 24 hours. Then the entry fails and emits `delivery.failed`.
 * - A retry can deliver the same `messageId` twice.
 */
export interface DeliveryOutbox {
  /** Stores the item and resolves with its entry. The item is durable before the promise resolves. */
  readonly enqueue: (item: OutboxItem) => Promise<OutboxEntry>;
  /** Lists entries in state `failed`, oldest first. */
  readonly listFailed: () => Promise<readonly FailedDelivery[]>;
  /**
   * Moves a `failed` entry back to `pending` with a fresh attempt budget and emits `delivery.cleared` (`retried`).
   * Resolves `false` if the entry is not `failed`.
   */
  readonly retry: (deliveryId: string) => Promise<boolean>;
  /**
   * Moves a `failed` entry to `dismissed` and emits `delivery.cleared` (`dismissed`). Resolves `false` if it is not
   * `failed`.
   */
  readonly dismiss: (deliveryId: string) => Promise<boolean>;
}

/** What the outbox needs from the Agent. */
export interface DeliveryOutboxDeps {
  /**
   * Delivers through the Frontend Binding `bindingId`. Rejects with a `DeliveryError` from `@wheatley/sdk`. An
   * unknown binding is a permanent error.
   */
  readonly deliver: (bindingId: string, delivery: Delivery) => Promise<void>;
  /**
   * The outbox calls it once per confirmed entry with a `sourceConversationId`, after it marks the entry `delivered`.
   * The outbox logs a rejection. The entry stays `delivered`, and the outbox does not call `deliver` or `onDelivered`
   * again for it.
   */
  readonly onDelivered: (entry: OutboxEntry) => Promise<void>;
}
