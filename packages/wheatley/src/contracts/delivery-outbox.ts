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
   * `DeliveryOutboxDeps.onDelivered` so the result is copied into the target Chat's current Conversation (ADR 0010).
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
  /** Epoch milliseconds of the next attempt, or `null` if none is scheduled. */
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
 * - Order is FIFO per `(bindingId, chatId)`. A `failed` or `dismissed` entry stops blocking newer entries.
 * - A permanent `DeliveryError` fails the entry at once and emits `delivery.failed`.
 * - A retryable error (any other error included) retries with exponential backoff and jitter, honoring
 *   `retryAfterMs`, for at most 10 attempts or 24 hours; then the entry fails and emits `delivery.failed`.
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
  /** Moves a `failed` entry to `dismissed` and emits `delivery.cleared`. Resolves `false` if it is not `failed`. */
  readonly dismiss: (deliveryId: string) => Promise<boolean>;
}

/** What the outbox needs from the Agent. */
export interface DeliveryOutboxDeps {
  /**
   * Delivers through the Frontend Binding `bindingId`. Rejects with a `DeliveryError` from `@wheatley/sdk`; an
   * unknown binding is a permanent error.
   */
  readonly deliver: (bindingId: string, delivery: Delivery) => Promise<void>;
  /** Called once per confirmed entry with a `sourceConversationId`, after the entry is marked `delivered`. */
  readonly onDelivered: (entry: OutboxEntry) => Promise<void>;
}
