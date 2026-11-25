import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { TriggerScheduleSchema } from "@wheatley/protocol";
import type {
  EventPayload,
  Trigger,
  TriggerInput,
  TriggerPatch,
  TriggerSchedule,
} from "@wheatley/protocol";
import type { Logger } from "@wheatley/sdk";
import { Type } from "typebox";
import { Value } from "typebox/value";

import { SeamError } from "../contracts/errors.js";
import type { Clock, EventSink } from "../contracts/module.js";
import type {
  TriggerActor,
  TriggerFiring,
  TriggerRunner,
  TriggerRuntime,
  WebhookEvent,
} from "../contracts/trigger-runtime.js";
import { armDueTimer } from "./due-timer.js";
import { errorText } from "./errors.js";
import {
  assertValidSchedule,
  initialFireAt,
  nextCronTick,
} from "./schedule.js";
import {
  blobColumn,
  enumColumn,
  integerColumn,
  optionalIntegerColumn,
  textColumn,
} from "./sql-row.js";
import type { SqlRow } from "./sql-row.js";

/**
 * A `cron` tick that the scheduler reaches later than this counts as missed and is skipped, for example after the host
 * slept.
 */
const CRON_GRACE_MS = 60_000;

/** The wait before the runtime tries again to start a webhook or `once` firing whose start failed. */
const START_RETRY_MS = 5000;

/** How long the runtime keeps the record of a Trigger Run for `isDeliverySuppressed`. */
const RUN_RECORD_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const TRIGGER_COLUMNS = `id, name, prompt, schedule_json, target_binding_id, target_chat_id, conversation_mode, paused,
  created_by, created_at, last_fired_at, next_fire_at`;

const decoder = new TextDecoder();

const iso = (epochMs: number): string => new Date(epochMs).toISOString();

const isoOrNull = (epochMs: number | null): string | null =>
  epochMs === null ? null : iso(epochMs);

const parseSchedule = (json: string): TriggerSchedule => {
  const value: unknown = JSON.parse(json);

  if (!Value.Check(TriggerScheduleSchema, value)) {
    throw new TypeError("Stored Trigger schedule is invalid");
  }

  return value;
};

const CONVERSATION_MODES: readonly Trigger["conversationMode"][] = [
  "per_firing",
  "shared",
];

const CREATORS: readonly Trigger["createdBy"][] = ["agent", "operator"];

const toTrigger = (row: SqlRow): Trigger => {
  const paused = integerColumn(row, "paused") === 1;

  return {
    conversationMode: enumColumn(row, "conversation_mode", CONVERSATION_MODES),
    createdAt: iso(integerColumn(row, "created_at")),
    createdBy: enumColumn(row, "created_by", CREATORS),
    id: textColumn(row, "id"),
    lastFiredAt: isoOrNull(optionalIntegerColumn(row, "last_fired_at")),
    name: textColumn(row, "name"),
    nextFireAt: paused
      ? null
      : isoOrNull(optionalIntegerColumn(row, "next_fire_at")),
    paused,
    prompt: textColumn(row, "prompt"),
    schedule: parseSchedule(textColumn(row, "schedule_json")),
    target: {
      bindingId: textColumn(row, "target_binding_id"),
      chatId: textColumn(row, "target_chat_id"),
    },
  };
};

const HeadersSchema = Type.Record(Type.String(), Type.String());

const parseHeaders = (json: string): Readonly<Record<string, string>> => {
  const value: unknown = JSON.parse(json);

  if (!Value.Check(HeadersSchema, value)) {
    throw new TypeError("Stored webhook headers are invalid");
  }

  return value;
};

const assertActorMayChange = (
  actor: TriggerActor,
  schedule: TriggerSchedule
): void => {
  if (actor === "agent" && schedule.kind === "webhook") {
    throw new SeamError(
      "forbidden",
      "Only the Operator manages webhook Triggers"
    );
  }
};

/** What the SQLite Trigger runtime needs from its Agent. */
export interface SqliteTriggerRuntimeOptions {
  readonly agentName: string;
  readonly db: DatabaseSync;
  readonly clock: Clock;
  readonly events: EventSink;
  readonly log: Logger;
  readonly runner: TriggerRunner;
}

/**
 * The `TriggerRuntime` of one Agent over `agent.sqlite` (ADR 0010), with its scheduler.
 *
 * The scheduler runs between `start` and `stop`. Before `start`, the runtime stores Triggers and webhook events but
 * fires nothing on schedule. `start` skips every `cron` tick that passed while the Agent was down, fires each overdue
 * `once` Trigger one time, and fires the stored webhook events in arrival order.
 *
 * Scheduled firings and webhook firings run one at a time, in due order. `fire` starts a Run at once.
 */
export class SqliteTriggerRuntime implements TriggerRuntime {
  readonly #options: SqliteTriggerRuntimeOptions;
  readonly #starts = new Set<Promise<unknown>>();
  #timer: NodeJS.Timeout | undefined;
  #webhookRetry: NodeJS.Timeout | undefined;
  #queue: Promise<void> = Promise.resolve();
  #running = false;

  constructor(options: SqliteTriggerRuntimeOptions) {
    this.#options = options;
  }

  readonly list = async (): Promise<readonly Trigger[]> =>
    await Promise.try(() =>
      this.#db
        .prepare(
          `SELECT ${TRIGGER_COLUMNS} FROM triggers_definitions ORDER BY seq`
        )
        .all()
        .map(toTrigger)
    );

  readonly get = async (triggerId: string): Promise<Trigger | undefined> =>
    await Promise.try(() => this.#read(triggerId));

  readonly create = async (
    input: TriggerInput,
    actor: TriggerActor
  ): Promise<Trigger> => await Promise.try(() => this.#create(input, actor));

  readonly update = async (
    triggerId: string,
    patch: TriggerPatch,
    actor: TriggerActor
  ): Promise<Trigger> =>
    await Promise.try(() => this.#update(triggerId, patch, actor));

  readonly delete = async (
    triggerId: string,
    actor: TriggerActor
  ): Promise<boolean> =>
    await Promise.try(() => this.#delete(triggerId, actor));

  readonly fire = async (
    triggerId: string
  ): Promise<{ readonly runId: string }> =>
    await this.#fire(this.#require(triggerId), undefined);

  readonly webhookTokenSecret = async (
    triggerId: string
  ): Promise<string | undefined> =>
    await Promise.try(() => {
      const trigger = this.#read(triggerId);

      return trigger?.schedule.kind === "webhook" && !trigger.paused
        ? trigger.schedule.tokenSecret
        : undefined;
    });

  readonly acceptWebhookEvent = async (
    triggerId: string,
    event: WebhookEvent
  ): Promise<{ readonly eventId: string }> => {
    const secret = await this.webhookTokenSecret(triggerId);

    if (secret === undefined) {
      throw new SeamError(
        "not_found",
        `No active webhook Trigger ${triggerId}`
      );
    }

    const eventId = randomUUID();

    this.#db
      .prepare(
        "INSERT INTO triggers_webhook_events (id, trigger_id, received_at, headers_json, body) VALUES (?, ?, ?, ?, ?)"
      )
      .run(
        eventId,
        triggerId,
        event.receivedAt,
        JSON.stringify(event.headers),
        event.body
      );
    this.#enqueue(this.#drainWebhookEvents);

    return { eventId };
  };

  readonly isDeliverySuppressed = async (runId: string): Promise<boolean> => {
    await this.#settleStarts();

    return (
      this.#db
        .prepare(
          "SELECT 1 FROM triggers_runs WHERE run_id = ? AND suppressed = 1"
        )
        .get(runId) !== undefined
    );
  };

  /**
   * Marks the Trigger Run `runId` so that `isDeliverySuppressed` resolves `true`. It backs the `suppress_delivery` Tool.
   *
   * Waits for Run starts in progress first, because a Run can call the Tool before `TriggerRunner.start` resolves.
   * Resolves `false` if no Trigger started the Run.
   */
  readonly suppressDelivery = async (runId: string): Promise<boolean> => {
    await this.#settleStarts();

    const { changes } = this.#db
      .prepare("UPDATE triggers_runs SET suppressed = 1 WHERE run_id = ?")
      .run(runId);

    return Number(changes) > 0;
  };

  /**
   * Starts the scheduler. It skips missed `cron` ticks, fires overdue `once` Triggers one time, and fires stored webhook
   * events. Resolves after the first scheduler pass started. Calling it twice does nothing.
   */
  readonly start = async (): Promise<void> => {
    await Promise.try(() => {
      if (this.#running) {
        return;
      }

      this.#running = true;
      this.#db
        .prepare("DELETE FROM triggers_runs WHERE started_at < ?")
        .run(this.#now() - RUN_RECORD_RETENTION_MS);
      this.#skipMissedCronTicks();
      this.#enqueue(this.#drainWebhookEvents);
      this.#enqueue(this.#runDue);
    });
  };

  /** Stops the scheduler and waits for the scheduler work in progress. Repeated calls do nothing. */
  readonly stop = async (): Promise<void> => {
    this.#running = false;
    clearTimeout(this.#timer);
    clearTimeout(this.#webhookRetry);
    this.#timer = undefined;
    this.#webhookRetry = undefined;
    await this.#queue;
  };

  get #db(): DatabaseSync {
    return this.#options.db;
  }

  readonly #now = (): number => this.#options.clock.now();

  readonly #read = (triggerId: string): Trigger | undefined => {
    const row = this.#db
      .prepare(
        `SELECT ${TRIGGER_COLUMNS} FROM triggers_definitions WHERE id = ?`
      )
      .get(triggerId);

    return row === undefined ? undefined : toTrigger(row);
  };

  readonly #require = (triggerId: string): Trigger => {
    const trigger = this.#read(triggerId);

    if (trigger === undefined) {
      throw new SeamError("not_found", `Unknown Trigger ${triggerId}`);
    }

    return trigger;
  };

  readonly #create = (input: TriggerInput, actor: TriggerActor): Trigger => {
    assertActorMayChange(actor, input.schedule);
    assertValidSchedule(input.schedule);

    const id = randomUUID();
    const now = this.#now();

    this.#db
      .prepare(
        `INSERT INTO triggers_definitions (${TRIGGER_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`
      )
      .run(
        id,
        input.name,
        input.prompt,
        JSON.stringify(input.schedule),
        input.target.bindingId,
        input.target.chatId,
        input.conversationMode ?? "per_firing",
        input.paused === true ? 1 : 0,
        actor,
        now,
        initialFireAt(input.schedule, now)
      );

    const trigger = this.#require(id);
    this.#changed("created", id, trigger);
    this.#rearm();

    return trigger;
  };

  readonly #update = (
    triggerId: string,
    patch: TriggerPatch,
    actor: TriggerActor
  ): Trigger => {
    const current = this.#require(triggerId);
    const schedule = patch.schedule ?? current.schedule;
    const paused = patch.paused ?? current.paused;

    assertActorMayChange(actor, current.schedule);
    assertActorMayChange(actor, schedule);
    assertValidSchedule(schedule);

    const nextFireAt = this.#nextFireAtAfterUpdate(current, patch);
    const target = patch.target ?? current.target;

    this.#db
      .prepare(
        `UPDATE triggers_definitions SET name = ?, prompt = ?, schedule_json = ?, target_binding_id = ?,
          target_chat_id = ?, conversation_mode = ?, paused = ?, next_fire_at = ? WHERE id = ?`
      )
      .run(
        patch.name ?? current.name,
        patch.prompt ?? current.prompt,
        JSON.stringify(schedule),
        target.bindingId,
        target.chatId,
        patch.conversationMode ?? current.conversationMode,
        paused ? 1 : 0,
        nextFireAt,
        triggerId
      );

    const updated = this.#require(triggerId);
    this.#changed("updated", triggerId, updated);
    this.#rearm();

    return updated;
  };

  readonly #delete = (triggerId: string, actor: TriggerActor): boolean => {
    const current = this.#read(triggerId);

    if (current === undefined) {
      return false;
    }

    assertActorMayChange(actor, current.schedule);
    this.#db
      .prepare("DELETE FROM triggers_definitions WHERE id = ?")
      .run(triggerId);
    this.#changed("deleted", triggerId);
    this.#rearm();

    return true;
  };

  readonly #storedNextFireAt = (triggerId: string): number | null => {
    const row = this.#db
      .prepare("SELECT next_fire_at FROM triggers_definitions WHERE id = ?")
      .get(triggerId);

    return row === undefined
      ? null
      : optionalIntegerColumn(row, "next_fire_at");
  };

  /**
   * A new schedule starts over. A `cron` Trigger that resumes skips the ticks of its pause. An overdue `once` Trigger
   * that resumes fires one time.
   */
  readonly #nextFireAtAfterUpdate = (
    current: Trigger,
    patch: TriggerPatch
  ): number | null => {
    const now = this.#now();

    if (patch.schedule !== undefined) {
      return initialFireAt(patch.schedule, now);
    }

    const resumes = current.paused && patch.paused === false;

    if (resumes && current.schedule.kind === "cron") {
      return nextCronTick(current.schedule, now);
    }

    return this.#storedNextFireAt(current.id);
  };

  /** Emits `trigger.changed`. A `deleted` change has no `trigger`. */
  readonly #changed = (
    change: "created" | "updated" | "deleted" | "fired",
    triggerId: string,
    trigger?: Trigger
  ): void => {
    const payload: EventPayload<"trigger.changed"> = {
      agent: this.#options.agentName,
      change,
      triggerId,
    };

    if (trigger !== undefined) {
      payload.trigger = trigger;
    }

    this.#options.events.emit("trigger.changed", payload);
  };

  readonly #settleStarts = async (): Promise<void> => {
    await Promise.allSettled(this.#starts);
  };

  /** Starts a Run for one firing, records it for `suppress_delivery`, and emits `fired`. */
  readonly #fire = async (
    trigger: Trigger,
    event: WebhookEvent | undefined
  ): Promise<{ readonly runId: string }> => {
    const firedAt = this.#now();
    const firingId = randomUUID();
    const body = event === undefined ? "" : `\n\n${decoder.decode(event.body)}`;

    const firing: TriggerFiring = {
      firingId,
      prompt: `${trigger.prompt}${body}`,
      target: trigger.target,
      trigger: { ...trigger, lastFiredAt: iso(firedAt) },
    };

    const started = this.#options.runner.start(firing);
    this.#starts.add(started);

    try {
      const { runId } = await started;

      this.#db
        .prepare(
          "INSERT OR IGNORE INTO triggers_runs (run_id, trigger_id, firing_id, started_at) VALUES (?, ?, ?, ?)"
        )
        .run(runId, trigger.id, firingId, firedAt);
      this.#db
        .prepare(
          "UPDATE triggers_definitions SET last_fired_at = ? WHERE id = ?"
        )
        .run(firedAt, trigger.id);
      this.#changed(
        "fired",
        trigger.id,
        this.#read(trigger.id) ?? firing.trigger
      );

      return { runId };
    } finally {
      this.#starts.delete(started);
    }
  };

  /** Runs `work` after the scheduler work queued before it. A failure does not stop later work. */
  readonly #enqueue = (work: () => Promise<void>): void => {
    const previous = this.#queue;

    this.#queue = (async () => {
      await previous;

      if (!this.#running) {
        return;
      }

      try {
        await work();
      } catch (error) {
        this.#options.log.error("Trigger scheduler work failed", {
          error: errorText(error),
        });
      }
    })();
  };

  /** Moves every overdue `cron` Trigger to its next future tick without a firing. */
  readonly #skipMissedCronTicks = (): void => {
    const now = this.#now();

    const rows = this.#db
      .prepare(
        `SELECT ${TRIGGER_COLUMNS} FROM triggers_definitions WHERE next_fire_at IS NOT NULL AND next_fire_at <= ?`
      )
      .all(now);

    for (const row of rows) {
      const trigger = toTrigger(row);

      if (trigger.schedule.kind === "cron") {
        this.#db
          .prepare(
            "UPDATE triggers_definitions SET next_fire_at = ? WHERE id = ?"
          )
          .run(nextCronTick(trigger.schedule, now), trigger.id);
        this.#options.log.info("Skipped missed cron ticks", {
          triggerId: trigger.id,
        });
      }
    }
  };

  /** Fires every due scheduled Trigger in due order, then arms the timer for the next one. */
  readonly #runDue = async (): Promise<void> => {
    clearTimeout(this.#timer);
    this.#timer = undefined;

    const now = this.#now();

    const rows = this.#db
      .prepare(
        `SELECT ${TRIGGER_COLUMNS} FROM triggers_definitions
          WHERE paused = 0 AND next_fire_at IS NOT NULL AND next_fire_at <= ? ORDER BY next_fire_at, seq`
      )
      .all(now);

    for (const row of rows) {
      const dueAt = integerColumn(row, "next_fire_at");

      // oxlint-disable-next-line no-await-in-loop -- Scheduled firings start one at a time, in due order.
      await this.#runDueTrigger(toTrigger(row), dueAt, now);
    }

    this.#rearm();
  };

  /**
   * Advances one due Trigger and fires it. The schedule state changes only if it still has the `dueAt` value that the
   * pass read, so a concurrent `update` wins.
   */
  readonly #runDueTrigger = async (
    trigger: Trigger,
    dueAt: number,
    now: number
  ): Promise<void> => {
    const { schedule } = trigger;
    const next = schedule.kind === "cron" ? nextCronTick(schedule, now) : null;

    const { changes } = this.#db
      .prepare(
        "UPDATE triggers_definitions SET next_fire_at = ? WHERE id = ? AND next_fire_at = ?"
      )
      .run(next, trigger.id, dueAt);

    if (Number(changes) === 0) {
      return;
    }

    if (schedule.kind === "cron" && now - dueAt > CRON_GRACE_MS) {
      this.#options.log.info("Skipped a missed cron tick", {
        triggerId: trigger.id,
      });

      return;
    }

    if (schedule.kind === "cron" && this.#options.runner.isActive(trigger.id)) {
      this.#options.log.info(
        "Skipped a cron tick that overlaps an active Run",
        {
          triggerId: trigger.id,
        }
      );

      return;
    }

    try {
      await this.#fire(trigger, undefined);
    } catch (error) {
      this.#options.log.error("A scheduled Trigger failed to start a Run", {
        error: errorText(error),
        triggerId: trigger.id,
      });

      if (schedule.kind === "once") {
        this.#retryOnce(trigger.id);
      }
    }
  };

  /**
   * Schedules a `once` firing whose start failed again after `START_RETRY_MS`, so that a reminder is not lost. A
   * concurrent `update` that set a new fire time wins.
   */
  readonly #retryOnce = (triggerId: string): void => {
    this.#db
      .prepare(
        "UPDATE triggers_definitions SET next_fire_at = ? WHERE id = ? AND next_fire_at IS NULL"
      )
      .run(this.#now() + START_RETRY_MS, triggerId);
  };

  /** Fires the stored webhook events in arrival order. On a failed start, it keeps the event and tries again later. */
  readonly #drainWebhookEvents = async (): Promise<void> => {
    while (this.#running) {
      const row = this.#db
        .prepare(
          `SELECT id, trigger_id, received_at, headers_json, body FROM triggers_webhook_events ORDER BY seq LIMIT 1`
        )
        .get();

      if (row === undefined) {
        return;
      }

      const eventId = textColumn(row, "id");
      const trigger = this.#read(textColumn(row, "trigger_id"));

      const event: WebhookEvent = {
        body: blobColumn(row, "body"),
        headers: parseHeaders(textColumn(row, "headers_json")),
        receivedAt: integerColumn(row, "received_at"),
      };

      try {
        if (trigger !== undefined) {
          // oxlint-disable-next-line no-await-in-loop -- Webhook events run in arrival order.
          await this.#fire(trigger, event);
        }
      } catch (error) {
        this.#options.log.error("A webhook Trigger failed to start a Run", {
          error: errorText(error),
          eventId,
        });
        this.#scheduleWebhookRetry();

        return;
      }

      this.#db
        .prepare("DELETE FROM triggers_webhook_events WHERE id = ?")
        .run(eventId);
    }
  };

  readonly #scheduleWebhookRetry = (): void => {
    clearTimeout(this.#webhookRetry);
    this.#webhookRetry = setTimeout(() => {
      this.#webhookRetry = undefined;
      this.#enqueue(this.#drainWebhookEvents);
    }, START_RETRY_MS);
    this.#webhookRetry.unref();
  };

  /** Arms the timer for the earliest scheduled firing. */
  readonly #rearm = (): void => {
    if (!this.#running) {
      return;
    }

    clearTimeout(this.#timer);

    const row = this.#db
      .prepare(
        "SELECT min(next_fire_at) AS due FROM triggers_definitions WHERE paused = 0 AND next_fire_at IS NOT NULL"
      )
      .get();

    this.#timer = armDueTimer(
      row === undefined ? null : optionalIntegerColumn(row, "due"),
      this.#now(),
      () => {
        this.#timer = undefined;
        this.#enqueue(this.#runDue);
      }
    );
  };
}
