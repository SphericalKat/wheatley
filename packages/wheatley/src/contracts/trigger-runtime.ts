import type {
  ChatKey,
  Trigger,
  TriggerInput,
  TriggerPatch,
} from "@wheatley-ai/protocol";

/** Who changes a Trigger. Only the Operator may create, change, or delete `webhook` Triggers (ADR 0010). */
export type TriggerActor = "agent" | "operator";

/** One accepted webhook request. The Trigger runtime stores it before the Ingress answers `202 Accepted`. */
export interface WebhookEvent {
  /** Epoch milliseconds. */
  readonly receivedAt: number;
  /** Lowercase header names, without `authorization`. */
  readonly headers: Readonly<Record<string, string>>;
  /** At most 256 KiB. */
  readonly body: Uint8Array;
}

/** One firing of a Trigger. The Trigger runtime gives it to the Agent, which runs it as a non-interactive Run. */
export interface TriggerFiring {
  readonly firingId: string;
  readonly trigger: Trigger;
  /** The Trigger prompt, with the webhook body appended for `webhook` firings. */
  readonly prompt: string;
  /**
   * The Chat that receives the result through the outbox, unless the Run calls the `suppress_delivery` Tool (see
   * `TriggerRuntime.isDeliverySuppressed`).
   */
  readonly target: ChatKey;
}

/** What the Trigger runtime needs from the Agent. */
export interface TriggerRunner {
  /**
   * Starts a non-interactive Run for a firing, in a new Conversation (`per_firing`) or the Trigger's shared
   * Conversation (`shared`). Resolves with the Run ID after the Agent stores the Run.
   *
   * When the Run ends, the Agent calls `TriggerRuntime.isDeliverySuppressed(runId)`. If it resolves `false`, the Agent
   * enqueues the final reply for `firing.target` with `sourceConversationId` set.
   */
  readonly start: (
    firing: TriggerFiring
  ) => Promise<{ readonly runId: string }>;
  /**
   * True while a Run of this Trigger is active, also during an Approval pause. The Trigger runtime calls it to skip a
   * `cron` tick that overlaps an active Run.
   */
  readonly isActive: (triggerId: string) => boolean;
}

/**
 * Stores and schedules the Triggers of one Agent in `agent.sqlite` (ADR 0010). Changes apply at once, without an
 * Agent restart.
 *
 * Scheduling rules:
 * - An overdue `once` Trigger fires one time at start.
 * - The runtime skips missed `cron` ticks and moves `nextFireAt` to the next future tick.
 * - The runtime skips a `cron` tick while the previous Run of the Trigger is active.
 * - Webhook events run in arrival order.
 *
 * The Triggers module also provides the Agent Tools `schedule_trigger`, `list_triggers`, `cancel_trigger`, and
 * `suppress_delivery` through its `ToolProvider`. `schedule_trigger` targets `ToolContext.chat` by default.
 * `suppress_delivery` stores a durable flag for `ToolContext.runId` that `isDeliverySuppressed` reads. It returns an
 * error result in a Run that no Trigger started.
 *
 * Every change emits `trigger.changed`: `created`, `updated`, `deleted`, or `fired` (also for a scheduled firing).
 */
export interface TriggerRuntime {
  /**
   * Resolves every Trigger of the Agent in creation order, also paused Triggers. Resolves an empty array if the Agent
   * has no Triggers. An `update` or a firing does not change the position of a Trigger.
   */
  readonly list: () => Promise<readonly Trigger[]>;
  /** Resolves one Trigger, or `undefined` for an unknown ID. It does not throw `SeamError("not_found")`. */
  readonly get: (triggerId: string) => Promise<Trigger | undefined>;
  /**
   * Creates a Trigger. Throws `SeamError("forbidden")` if an Agent creates a `webhook`
   * Trigger, and `SeamError("invalid_name")` for an invalid cron expression or time zone.
   */
  readonly create: (
    input: TriggerInput,
    actor: TriggerActor
  ) => Promise<Trigger>;
  /** Changes a Trigger. Throws `SeamError("not_found")` and the errors of `create`. */
  readonly update: (
    triggerId: string,
    patch: TriggerPatch,
    actor: TriggerActor
  ) => Promise<Trigger>;
  /** Deletes a Trigger. Resolves `false` if it did not exist. Throws `SeamError("forbidden")` as `create` does. */
  readonly delete: (triggerId: string, actor: TriggerActor) => Promise<boolean>;
  /** Fires a Trigger now, outside its schedule, and emits `trigger.changed` (`fired`). Throws `SeamError("not_found")`. */
  readonly fire: (triggerId: string) => Promise<{ readonly runId: string }>;
  /**
   * The secret name of a `webhook` Trigger's Bearer token, or `undefined` if the Trigger does not exist, is paused,
   * or is not a `webhook` Trigger.
   */
  readonly webhookTokenSecret: (
    triggerId: string
  ) => Promise<string | undefined>;
  /**
   * Stores a webhook event and queues its firing. Resolves once the event is durable. Throws `SeamError("not_found")`
   * if the Trigger is not an active `webhook` Trigger.
   */
  readonly acceptWebhookEvent: (
    triggerId: string,
    event: WebhookEvent
  ) => Promise<{ readonly eventId: string }>;
  /**
   * True if the Trigger Run `runId` called `suppress_delivery`, so the Agent must not enqueue its final reply. Resolves
   * `false` for any other Run.
   */
  readonly isDeliverySuppressed: (runId: string) => Promise<boolean>;
}
