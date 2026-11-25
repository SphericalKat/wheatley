import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";

import { DELIVERY_PREVIEW_MAX_LENGTH } from "@wheatley/protocol";
import type { FailedDelivery } from "@wheatley/protocol";
import { isDeliveryError } from "@wheatley/sdk";
import type { Delivery, Logger } from "@wheatley/sdk";

import type {
  DeliveryOutbox,
  DeliveryOutboxDeps,
  OutboxEntry,
  OutboxItem,
  OutboxStatus,
} from "../contracts/delivery-outbox.js";
import type { Clock, EventSink } from "../contracts/module.js";
import { decodeDelivery, encodeDelivery } from "./delivery-codec.js";
import {
  integerColumn,
  optionalIntegerColumn,
  optionalTextColumn,
  textColumn,
} from "./sql-row.js";
import type { SqlRow } from "./sql-row.js";

/** Retries stop after this many attempts (ADR 0010). */
export const MAX_DELIVERY_ATTEMPTS = 10;

/** Retries stop when the next attempt would start later than this after the first attempt (ADR 0010). */
export const MAX_DELIVERY_RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The backoff before the second attempt. Each later backoff doubles, up to `MAX_BACKOFF_MS`. */
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60 * 60 * 1000;

/** The timer never sleeps longer than this, so that the outbox notices a changed system clock within a minute. */
const MAX_TIMER_MS = 60_000;

/** How long `stop` waits for deliveries in progress. */
const STOP_WAIT_MS = 10_000;

/** How long the outbox keeps `delivered` and `dismissed` entries. */
const FINISHED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const ENTRY_COLUMNS = `delivery_id, binding_id, chat_id, delivery_json, source_conversation_id, status, attempts,
  budget_started_at, next_attempt_at, last_error, permanent, created_at, finished_at`;

/** The oldest `pending` entry of each Chat. Only it may be attempted, which keeps the order FIFO per Chat. */
const CHAT_HEADS = `SELECT ${ENTRY_COLUMNS} FROM outbox_entries AS entry WHERE status = 'pending' AND seq = (
  SELECT min(seq) FROM outbox_entries WHERE status = 'pending' AND binding_id = entry.binding_id
    AND chat_id = entry.chat_id)`;

const STATUSES: readonly OutboxStatus[] = [
  "pending",
  "delivered",
  "failed",
  "dismissed",
];

const statusOf = (row: SqlRow): OutboxStatus => {
  const stored = textColumn(row, "status");
  const status = STATUSES.find((candidate) => candidate === stored);

  if (status === undefined) {
    throw new TypeError(`Unknown outbox status: ${stored}`);
  }

  return status;
};

/** One stored row: the public entry plus the columns that only the outbox reads. */
interface StoredEntry {
  readonly entry: OutboxEntry;
  readonly budgetStartedAt: number;
  readonly finishedAt: number | null;
}

const toStoredEntry = (row: SqlRow): StoredEntry => ({
  budgetStartedAt: integerColumn(row, "budget_started_at"),
  entry: {
    attempts: integerColumn(row, "attempts"),
    bindingId: textColumn(row, "binding_id"),
    chatId: textColumn(row, "chat_id"),
    createdAt: integerColumn(row, "created_at"),
    delivery: decodeDelivery(textColumn(row, "delivery_json")),
    deliveryId: textColumn(row, "delivery_id"),
    lastError: optionalTextColumn(row, "last_error"),
    nextAttemptAt: optionalIntegerColumn(row, "next_attempt_at"),
    permanent: integerColumn(row, "permanent") === 1,
    sourceConversationId:
      optionalTextColumn(row, "source_conversation_id") ?? undefined,
    status: statusOf(row),
  },
  finishedAt: optionalIntegerColumn(row, "finished_at"),
});

const previewText = (delivery: Delivery): string => {
  if (delivery.kind === "message") {
    return delivery.text;
  }

  return delivery.kind === "approval_requested"
    ? `Approval requested: ${delivery.toolName}`
    : `Approval resolved: ${delivery.decision}`;
};

const previewOf = (delivery: Delivery): string =>
  previewText(delivery).slice(0, DELIVERY_PREVIEW_MAX_LENGTH);

const errorText = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** A failed delivery attempt, parsed from the rejection of `deliver`. Any error other than a `DeliveryError` retries. */
interface AttemptFailure {
  readonly message: string;
  readonly permanent: boolean;
  readonly retryAfterMs: number;
}

const attemptFailureOf = (cause: unknown): AttemptFailure => {
  const deliveryError = isDeliveryError(cause) ? cause : undefined;

  return {
    message: errorText(cause),
    permanent: deliveryError?.kind === "permanent",
    retryAfterMs: deliveryError?.retryAfterMs ?? 0,
  };
};

/** What the SQLite outbox needs from its Agent. */
export interface SqliteDeliveryOutboxOptions {
  readonly agentName: string;
  readonly db: DatabaseSync;
  readonly clock: Clock;
  readonly events: EventSink;
  readonly log: Logger;
  readonly deps: DeliveryOutboxDeps;
  /** Returns a number in `[0, 1)` for backoff jitter, for example `Math.random`. */
  readonly random: () => number;
}

/**
 * The `DeliveryOutbox` of one Agent over `agent.sqlite` (ADR 0007, ADR 0010).
 *
 * Deliveries run between `start` and `stop`. Before `start`, `enqueue` stores entries without an attempt. Chats
 * deliver independently of each other, and one Chat delivers one entry at a time, oldest first.
 *
 * Backoff: the attempt `n` that fails with a retryable error waits `min(1s * 2^(n-1), 1h)`, scaled by a jitter factor
 * in `[0.5, 1)`, and at least the `retryAfterMs` of the error.
 */
export class SqliteDeliveryOutbox implements DeliveryOutbox {
  readonly #options: SqliteDeliveryOutboxOptions;
  #timer: NodeJS.Timeout | undefined;
  #pumping: Promise<void> | undefined;
  #again = false;
  #running = false;

  constructor(options: SqliteDeliveryOutboxOptions) {
    this.#options = options;
  }

  readonly enqueue = async (item: OutboxItem): Promise<OutboxEntry> => {
    await Promise.resolve();
    const deliveryId = randomUUID();
    const now = this.#now();

    const delivery: Delivery = {
      ...item.delivery,
      chatId: item.chatId,
      messageId: deliveryId,
    };

    this.#db
      .prepare(
        `INSERT INTO outbox_entries (${ENTRY_COLUMNS}) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, NULL, 0, ?, NULL)`
      )
      .run(
        deliveryId,
        item.bindingId,
        item.chatId,
        encodeDelivery(delivery),
        item.sourceConversationId ?? null,
        now,
        now,
        now
      );

    const stored = this.#read(deliveryId);

    if (stored === undefined) {
      throw new Error(`Outbox entry ${deliveryId} vanished`);
    }

    this.#kick();

    return stored.entry;
  };

  readonly listFailed = async (): Promise<readonly FailedDelivery[]> => {
    await Promise.resolve();

    return this.#db
      .prepare(
        `SELECT ${ENTRY_COLUMNS} FROM outbox_entries WHERE status = 'failed' ORDER BY seq`
      )
      .all()
      .map((row) => this.#failedDelivery(toStoredEntry(row)));
  };

  readonly retry = async (deliveryId: string): Promise<boolean> => {
    await Promise.resolve();
    const now = this.#now();

    const { changes } = this.#db
      .prepare(
        `UPDATE outbox_entries SET status = 'pending', attempts = 0, permanent = 0, budget_started_at = ?,
          next_attempt_at = ?, finished_at = NULL WHERE delivery_id = ? AND status = 'failed'`
      )
      .run(now, now, deliveryId);

    if (Number(changes) === 0) {
      return false;
    }

    this.#cleared(deliveryId, "retried");
    this.#kick();

    return true;
  };

  readonly dismiss = async (deliveryId: string): Promise<boolean> => {
    await Promise.resolve();

    const { changes } = this.#db
      .prepare(
        `UPDATE outbox_entries SET status = 'dismissed', next_attempt_at = NULL, finished_at = ?
          WHERE delivery_id = ? AND status = 'failed'`
      )
      .run(this.#now(), deliveryId);

    if (Number(changes) === 0) {
      return false;
    }

    this.#cleared(deliveryId, "dismissed");

    return true;
  };

  /** Starts deliveries, including the entries that waited while the Agent was down. Calling it twice does nothing. */
  readonly start = async (): Promise<void> => {
    if (this.#running) {
      return;
    }

    this.#running = true;
    this.#db
      .prepare(
        "DELETE FROM outbox_entries WHERE status IN ('delivered', 'dismissed') AND finished_at < ?"
      )
      .run(this.#now() - FINISHED_RETENTION_MS);
    this.#kick();
    await Promise.resolve();
  };

  /**
   * Stops deliveries. Waits up to 10 seconds for attempts in progress. An attempt that ends later still records its
   * result. Repeated calls do nothing.
   */
  readonly stop = async (): Promise<void> => {
    this.#running = false;
    clearTimeout(this.#timer);
    this.#timer = undefined;

    const pumping = this.#pumping;

    if (pumping === undefined) {
      return;
    }

    await Promise.race([
      pumping,
      sleep(STOP_WAIT_MS, undefined, { ref: false }),
    ]);
  };

  get #db(): DatabaseSync {
    return this.#options.db;
  }

  readonly #now = (): number => this.#options.clock.now();

  readonly #read = (deliveryId: string): StoredEntry | undefined => {
    const row = this.#db
      .prepare(
        `SELECT ${ENTRY_COLUMNS} FROM outbox_entries WHERE delivery_id = ?`
      )
      .get(deliveryId);

    return row === undefined ? undefined : toStoredEntry(row);
  };

  readonly #failedDelivery = (stored: StoredEntry): FailedDelivery => {
    const { entry } = stored;

    return {
      agent: this.#options.agentName,
      attempts: entry.attempts,
      bindingId: entry.bindingId,
      chatId: entry.chatId,
      createdAt: new Date(entry.createdAt).toISOString(),
      deliveryId: entry.deliveryId,
      failedAt: new Date(stored.finishedAt ?? entry.createdAt).toISOString(),
      kind: entry.delivery.kind,
      lastError: entry.lastError ?? "",
      permanent: entry.permanent,
      preview: previewOf(entry.delivery),
    };
  };

  readonly #cleared = (
    deliveryId: string,
    reason: "retried" | "dismissed"
  ): void => {
    this.#options.events.emit("delivery.cleared", {
      agent: this.#options.agentName,
      deliveryId,
      reason,
    });
  };

  /** Starts a delivery pass, or asks the pass in progress for one more round. */
  readonly #kick = (): void => {
    if (!this.#running) {
      return;
    }

    if (this.#pumping !== undefined) {
      this.#again = true;

      return;
    }

    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#pumping = this.#pump();
  };

  readonly #pump = async (): Promise<void> => {
    try {
      do {
        this.#again = false;
        // oxlint-disable-next-line no-await-in-loop -- Each round attempts the Chat heads that the last round left due.
        await this.#round();
      } while (this.#again && this.#running);
    } catch (error) {
      this.#options.log.error("Outbox delivery pass failed", {
        error: errorText(error),
      });
    } finally {
      this.#pumping = undefined;
      this.#rearm();
    }
  };

  /** Attempts the due head of every Chat in parallel. A confirmed delivery asks for another round. */
  readonly #round = async (): Promise<void> => {
    const heads = this.#db
      .prepare(`${CHAT_HEADS} AND next_attempt_at <= ? ORDER BY seq`)
      .all(this.#now())
      .map(toStoredEntry);

    const results = await Promise.all(heads.map(this.#attempt));

    if (results.includes("delivered")) {
      this.#again = true;
    }
  };

  readonly #attempt = async (stored: StoredEntry): Promise<OutboxStatus> => {
    const { entry } = stored;
    const attempts = entry.attempts + 1;

    try {
      await this.#options.deps.deliver(entry.bindingId, entry.delivery);
    } catch (error) {
      return this.#recordFailure(stored, attempts, attemptFailureOf(error));
    }

    this.#db
      .prepare(
        `UPDATE outbox_entries SET status = 'delivered', attempts = ?, next_attempt_at = NULL, finished_at = ?
          WHERE delivery_id = ?`
      )
      .run(attempts, this.#now(), entry.deliveryId);

    if (entry.sourceConversationId !== undefined) {
      await this.#copy({
        ...entry,
        attempts,
        nextAttemptAt: null,
        status: "delivered",
      });
    }

    return "delivered";
  };

  readonly #copy = async (entry: OutboxEntry): Promise<void> => {
    try {
      await this.#options.deps.onDelivered(entry);
    } catch (error) {
      this.#options.log.error(
        "Copying a delivered Trigger result into its Chat failed",
        { deliveryId: entry.deliveryId, error: errorText(error) }
      );
    }
  };

  readonly #recordFailure = (
    stored: StoredEntry,
    attempts: number,
    failure: AttemptFailure
  ): OutboxStatus => {
    const now = this.#now();
    const { permanent } = failure;
    const nextAttemptAt = now + this.#backoff(attempts, failure);

    const exhausted =
      attempts >= MAX_DELIVERY_ATTEMPTS ||
      nextAttemptAt > stored.budgetStartedAt + MAX_DELIVERY_RETRY_WINDOW_MS;

    const failed = permanent || exhausted;

    this.#db
      .prepare(
        `UPDATE outbox_entries SET status = ?, attempts = ?, next_attempt_at = ?, last_error = ?, permanent = ?,
          finished_at = ? WHERE delivery_id = ?`
      )
      .run(
        failed ? "failed" : "pending",
        attempts,
        failed ? null : nextAttemptAt,
        failure.message,
        permanent ? 1 : 0,
        failed ? now : null,
        stored.entry.deliveryId
      );

    if (failed) {
      const updated = this.#read(stored.entry.deliveryId);

      if (updated !== undefined) {
        this.#options.events.emit("delivery.failed", {
          agent: this.#options.agentName,
          delivery: this.#failedDelivery(updated),
        });
      }
    }

    return failed ? "failed" : "pending";
  };

  readonly #backoff = (attempts: number, failure: AttemptFailure): number => {
    const exponential = Math.min(
      BASE_BACKOFF_MS * 2 ** (attempts - 1),
      MAX_BACKOFF_MS
    );

    const jitter = 0.5 + this.#options.random() * 0.5;

    return Math.max(Math.round(exponential * jitter), failure.retryAfterMs);
  };

  /** Arms the timer for the earliest Chat head that waits for a backoff, at most `MAX_TIMER_MS` ahead. */
  readonly #rearm = (): void => {
    if (!this.#running || this.#pumping !== undefined) {
      return;
    }

    clearTimeout(this.#timer);
    this.#timer = undefined;

    const row = this.#db
      .prepare(`SELECT min(next_attempt_at) AS due FROM (${CHAT_HEADS})`)
      .get();

    const due = row === undefined ? null : optionalIntegerColumn(row, "due");

    if (due === null) {
      return;
    }

    const delay = Math.min(Math.max(due - this.#now(), 0), MAX_TIMER_MS);

    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#kick();
    }, delay);
    this.#timer.unref();
  };
}
