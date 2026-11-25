import type { Trigger, TriggerInput, TriggerPatch } from "@wheatley/protocol";

import { SeamError } from "./errors.js";
import { simulateIo } from "./fake-io.js";
import { systemClock } from "./module.js";
import type { Clock, EventSink } from "./module.js";
import type {
  TriggerActor,
  TriggerRunner,
  TriggerRuntime,
  WebhookEvent,
} from "./trigger-runtime.js";

const assertActorMayChange = (
  actor: TriggerActor,
  trigger: Pick<Trigger, "schedule">
): void => {
  if (actor === "agent" && trigger.schedule.kind === "webhook") {
    throw new SeamError(
      "forbidden",
      "Only the Operator manages webhook Triggers"
    );
  }
};

/** Options of the fake Trigger runtime. */
export interface FakeTriggerRuntimeOptions {
  readonly clock?: Clock;
  readonly events?: EventSink;
}

/**
 * An in-memory `TriggerRuntime` without a scheduler: `fire` and `acceptWebhookEvent` start Runs at once, and
 * `nextFireAt` stays `null`.
 */
export class InMemoryTriggerRuntime implements TriggerRuntime {
  readonly #agentName: string;
  readonly #runner: TriggerRunner;
  readonly #clock: Clock;
  readonly #emitter: EventSink | undefined;
  readonly #triggers = new Map<string, Trigger>();
  readonly #runIds = new Set<string>();
  readonly #suppressed = new Set<string>();
  readonly #events: {
    readonly triggerId: string;
    readonly event: WebhookEvent;
  }[] = [];
  #nextId = 1;
  #nextFiringId = 1;

  constructor(
    agentName: string,
    runner: TriggerRunner,
    options: FakeTriggerRuntimeOptions = {}
  ) {
    this.#agentName = agentName;
    this.#runner = runner;
    this.#clock = options.clock ?? systemClock;
    this.#emitter = options.events;
  }

  /** Accepted webhook events in arrival order, for test assertions. */
  get webhookEvents(): readonly {
    readonly triggerId: string;
    readonly event: WebhookEvent;
  }[] {
    return this.#events;
  }

  readonly list = async (): Promise<readonly Trigger[]> => {
    await simulateIo();

    return [...this.#triggers.values()];
  };

  readonly get = async (triggerId: string): Promise<Trigger | undefined> => {
    await simulateIo();

    return this.#triggers.get(triggerId);
  };

  readonly create = async (
    input: TriggerInput,
    actor: TriggerActor
  ): Promise<Trigger> => {
    await simulateIo();
    assertActorMayChange(actor, input);
    const id = `trigger-${this.#nextId}`;
    this.#nextId += 1;

    const trigger: Trigger = {
      conversationMode: input.conversationMode ?? "per_firing",
      createdAt: new Date(this.#clock.now()).toISOString(),
      createdBy: actor,
      id,
      lastFiredAt: null,
      name: input.name,
      nextFireAt: null,
      paused: input.paused ?? false,
      prompt: input.prompt,
      schedule: input.schedule,
      target: input.target,
    };

    this.#triggers.set(id, trigger);
    this.#changed("created", trigger);

    return trigger;
  };

  readonly update = async (
    triggerId: string,
    patch: TriggerPatch,
    actor: TriggerActor
  ): Promise<Trigger> => {
    await simulateIo();
    const current = this.#require(triggerId);
    assertActorMayChange(actor, current);
    const updated: Trigger = { ...current, ...patch };
    assertActorMayChange(actor, updated);
    this.#triggers.set(triggerId, updated);
    this.#changed("updated", updated);

    return updated;
  };

  readonly delete = async (
    triggerId: string,
    actor: TriggerActor
  ): Promise<boolean> => {
    await simulateIo();
    const current = this.#triggers.get(triggerId);

    if (current === undefined) {
      return false;
    }

    assertActorMayChange(actor, current);
    this.#triggers.delete(triggerId);
    this.#emitter?.emit("trigger.changed", {
      agent: this.#agentName,
      change: "deleted",
      triggerId,
    });

    return true;
  };

  readonly fire = async (
    triggerId: string
  ): Promise<{ readonly runId: string }> => {
    await simulateIo();

    return await this.#start(this.#require(triggerId), undefined);
  };

  readonly webhookTokenSecret = async (
    triggerId: string
  ): Promise<string | undefined> => {
    await simulateIo();
    const trigger = this.#triggers.get(triggerId);

    return trigger?.schedule.kind === "webhook" && !trigger.paused
      ? trigger.schedule.tokenSecret
      : undefined;
  };

  readonly acceptWebhookEvent = async (
    triggerId: string,
    event: WebhookEvent
  ): Promise<{ readonly eventId: string }> => {
    const secret = await this.webhookTokenSecret(triggerId);
    const trigger = this.#triggers.get(triggerId);

    if (secret === undefined || trigger === undefined) {
      throw new SeamError(
        "not_found",
        `No active webhook Trigger ${triggerId}`
      );
    }

    this.#events.push({ event, triggerId });
    await this.#start(trigger, event);

    return { eventId: `event-${this.#events.length}` };
  };

  readonly isDeliverySuppressed = async (runId: string): Promise<boolean> => {
    await simulateIo();

    return this.#suppressed.has(runId);
  };

  /**
   * Does what the `suppress_delivery` Tool does in the real module. Resolves `false` for a Run that no Trigger started.
   */
  readonly suppressDelivery = async (runId: string): Promise<boolean> => {
    await simulateIo();

    if (!this.#runIds.has(runId)) {
      return false;
    }

    this.#suppressed.add(runId);

    return true;
  };

  readonly #changed = (
    change: "created" | "updated" | "fired",
    trigger: Trigger
  ): void => {
    this.#emitter?.emit("trigger.changed", {
      agent: this.#agentName,
      change,
      trigger,
      triggerId: trigger.id,
    });
  };

  readonly #require = (triggerId: string): Trigger => {
    const trigger = this.#triggers.get(triggerId);

    if (trigger === undefined) {
      throw new SeamError("not_found", `Unknown Trigger ${triggerId}`);
    }

    return trigger;
  };

  readonly #start = async (
    trigger: Trigger,
    event: WebhookEvent | undefined
  ): Promise<{ readonly runId: string }> => {
    const body =
      event === undefined ? "" : `\n\n${new TextDecoder().decode(event.body)}`;

    const fired: Trigger = {
      ...trigger,
      lastFiredAt: new Date(this.#clock.now()).toISOString(),
    };

    this.#triggers.set(trigger.id, fired);
    const firingId = `firing-${this.#nextFiringId}`;
    this.#nextFiringId += 1;

    const started = await this.#runner.start({
      firingId,
      prompt: `${trigger.prompt}${body}`,
      target: trigger.target,
      trigger: fired,
    });

    this.#runIds.add(started.runId);
    this.#changed("fired", fired);

    return started;
  };
}
