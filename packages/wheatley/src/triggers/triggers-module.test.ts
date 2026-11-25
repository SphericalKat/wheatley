import type { DatabaseSync } from "node:sqlite";

import type { EventName, EventPayload, TriggerInput } from "@wheatley/protocol";
import type { ToolContext, ToolResult } from "@wheatley/sdk";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { SeamError } from "../contracts/errors.js";
import { migrationNamespace } from "../contracts/module.js";
import type {
  AgentModuleContext,
  ModuleInstance,
} from "../contracts/module.js";
import type { TriggerFiring } from "../contracts/trigger-runtime.js";
import { openAgentDatabase } from "../db/database.js";
import { runMigrations } from "../db/migrations.js";
import { triggersModule } from "./module.js";
import type { TriggersModuleApi } from "./module.js";

const START = Date.parse("2026-11-26T10:00:00.000Z");
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const encoder = new TextEncoder();
const rpcContext = { connectionId: "c1", signal: new AbortController().signal };

const cronInput = (timezone: string): TriggerInput => ({
  name: "morning plan",
  prompt: "Plan the day",
  schedule: { kind: "cron", schedule: "0 8 * * *", timezone },
  target: { bindingId: "tg", chatId: "1" },
});

const webhookInput: TriggerInput = {
  name: "CI results",
  prompt: "Summarize this CI event",
  schedule: { kind: "webhook", tokenSecret: "HOOK_TOKEN" },
  target: { bindingId: "slack", chatId: "C1" },
};

interface EmittedEvent {
  readonly name: EventName;
  readonly payload: EventPayload<EventName>;
}

let db: DatabaseSync;
let firings: TriggerFiring[];
let events: EmittedEvent[];
let activeTriggers: Set<string>;
let failingStarts: number;
let instances: ModuleInstance<TriggersModuleApi>[];

const createModule = async (): Promise<ModuleInstance<TriggersModuleApi>> => {
  const ctx: AgentModuleContext = {
    agentDir: "/data/agents/home",
    agentName: "home",
    clock: { now: () => Date.now() },
    db,
    events: {
      emit: (name, payload) => {
        events.push({ name, payload });
      },
    },
    log: { debug: () => {}, error: () => {}, info: () => {}, warn: () => {} },
  };

  const instance = await triggersModule.create(ctx, {
    runner: {
      isActive: (triggerId) => activeTriggers.has(triggerId),
      start: async (firing) => {
        await Promise.resolve();

        if (failingStarts > 0) {
          failingStarts -= 1;
          throw new Error("The Agent is not ready");
        }

        firings.push(firing);

        return { runId: `run-${firings.length}` };
      },
    },
  });

  instances.push(instance);

  return instance;
};

const startModule = async (): Promise<ModuleInstance<TriggersModuleApi>> => {
  const instance = await createModule();
  await instance.start?.();
  await vi.advanceTimersByTimeAsync(0);

  return instance;
};

const stopModule = async (
  instance: ModuleInstance<TriggersModuleApi>
): Promise<void> => {
  await instance.stop?.();
  instances = instances.filter((candidate) => candidate !== instance);
};

const CURRENT_CHAT = { bindingId: "tg", chatId: "1" } as const;

const toolContext = (
  runId: string,
  chat: ToolContext["chat"] = CURRENT_CHAT
): ToolContext => ({
  agentName: "home",
  chat,
  conversationId: "conversation-1",
  log: { debug: () => {}, error: () => {}, info: () => {}, warn: () => {} },
  runId,
  signal: new AbortController().signal,
  toolCallId: "call-1",
  workspaceDir: "/data/agents/home/workspace",
});

const textOf = (result: ToolResult): string =>
  result.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");

const changes = (): string[] =>
  events.flatMap(({ name, payload }) =>
    name === "trigger.changed" && "change" in payload ? [payload.change] : []
  );

beforeEach(() => {
  vi.useFakeTimers({ now: START });
  db = openAgentDatabase(":memory:");
  runMigrations(db, [migrationNamespace(triggersModule)]);
  firings = [];
  events = [];
  activeTriggers = new Set();
  failingStarts = 0;
  instances = [];
});

afterEach(async () => {
  for (const instance of instances) {
    // oxlint-disable-next-line no-await-in-loop -- Each module stops before the database closes.
    await instance.stop?.();
  }

  db.close();
  vi.useRealTimers();
});

it("computes the next cron tick in the Trigger's time zone", async () => {
  const { api } = await startModule();

  const berlin = await api.runtime.create(cronInput("Europe/Berlin"), "agent");

  const newYork = await api.runtime.create(
    cronInput("America/New_York"),
    "agent"
  );

  expect(berlin.nextFireAt).toBe("2026-11-27T07:00:00.000Z");
  expect(newYork.nextFireAt).toBe("2026-11-26T13:00:00.000Z");
});

it("fires a cron Trigger at its tick without an Agent restart and moves to the next tick", async () => {
  const { api } = await startModule();
  const trigger = await api.runtime.create(cronInput("Europe/Berlin"), "agent");

  vi.setSystemTime(Date.parse("2026-11-27T06:59:00.000Z"));
  await vi.advanceTimersByTimeAsync(0);

  expect(firings).toHaveLength(0);

  await vi.advanceTimersByTimeAsync(MINUTE);

  expect(firings).toHaveLength(1);
  expect(firings[0]).toMatchObject({
    prompt: "Plan the day",
    target: { bindingId: "tg", chatId: "1" },
    trigger: { id: trigger.id, lastFiredAt: "2026-11-27T07:00:00.000Z" },
  });
  await expect(api.runtime.get(trigger.id)).resolves.toMatchObject({
    lastFiredAt: "2026-11-27T07:00:00.000Z",
    nextFireAt: "2026-11-28T07:00:00.000Z",
  });
  expect(changes()).toStrictEqual(["created", "fired"]);
});

it("skips a cron tick that overlaps an active Run of the same Trigger", async () => {
  const { api } = await startModule();
  const trigger = await api.runtime.create(cronInput("UTC"), "agent");
  activeTriggers.add(trigger.id);

  await vi.advanceTimersByTimeAsync(DAY);

  expect(firings).toHaveLength(0);
  await expect(api.runtime.get(trigger.id)).resolves.toMatchObject({
    lastFiredAt: null,
    nextFireAt: "2026-11-28T08:00:00.000Z",
  });

  activeTriggers.clear();
  await vi.advanceTimersByTimeAsync(DAY);

  expect(firings.map((firing) => firing.trigger.id)).toStrictEqual([
    trigger.id,
  ]);
});

it("skips cron ticks that passed while the Agent was down", async () => {
  const first = await startModule();
  const trigger = await first.api.runtime.create(cronInput("UTC"), "agent");
  await stopModule(first);

  vi.setSystemTime(START + 3 * DAY);
  const second = await startModule();

  expect(firings).toHaveLength(0);
  await expect(second.api.runtime.get(trigger.id)).resolves.toMatchObject({
    nextFireAt: "2026-11-30T08:00:00.000Z",
  });
});

it("catches up an overdue once Trigger one time at start", async () => {
  const first = await startModule();

  const trigger = await first.api.runtime.create(
    {
      name: "call mom",
      prompt: "Remind me to call mom",
      schedule: { at: "2026-11-26T12:00:00.000Z", kind: "once" },
      target: { bindingId: "tg", chatId: "1" },
    },
    "agent"
  );

  await stopModule(first);

  vi.setSystemTime(START + DAY);
  const second = await startModule();

  expect(firings.map((firing) => firing.prompt)).toStrictEqual([
    "Remind me to call mom",
  ]);
  await expect(second.api.runtime.get(trigger.id)).resolves.toMatchObject({
    lastFiredAt: "2026-11-27T10:00:00.000Z",
    nextFireAt: null,
  });

  await stopModule(second);
  await startModule();

  expect(firings).toHaveLength(1);
});

it("retries a once Trigger whose Run failed to start", async () => {
  const { api } = await startModule();
  failingStarts = 2;

  const trigger = await api.runtime.create(
    {
      name: "tea",
      prompt: "Tea is ready",
      schedule: { at: "2026-11-26T10:05:00.000Z", kind: "once" },
      target: { bindingId: "tg", chatId: "1" },
    },
    "agent"
  );

  await vi.advanceTimersByTimeAsync(5 * MINUTE);

  expect(firings).toHaveLength(0);
  await expect(api.runtime.get(trigger.id)).resolves.toMatchObject({
    nextFireAt: "2026-11-26T10:05:05.000Z",
  });

  await vi.advanceTimersByTimeAsync(MINUTE);

  expect(firings.map((firing) => firing.prompt)).toStrictEqual([
    "Tea is ready",
  ]);
  await expect(api.runtime.get(trigger.id)).resolves.toMatchObject({
    nextFireAt: null,
  });
});

it("fires a once Trigger at its time while the Agent runs", async () => {
  const { api } = await startModule();
  await api.runtime.create(
    {
      name: "tea",
      prompt: "Tea is ready",
      schedule: { at: "2026-11-26T10:05:00.000Z", kind: "once" },
      target: { bindingId: "tg", chatId: "1" },
    },
    "agent"
  );

  await vi.advanceTimersByTimeAsync(4 * MINUTE);

  expect(firings).toHaveLength(0);

  await vi.advanceTimersByTimeAsync(MINUTE);

  expect(firings.map((firing) => firing.prompt)).toStrictEqual([
    "Tea is ready",
  ]);
});

it("does not fire a paused Trigger and skips the paused ticks when it resumes", async () => {
  const { api } = await startModule();

  const trigger = await api.runtime.create(
    { ...cronInput("UTC"), paused: true },
    "agent"
  );

  expect(trigger.nextFireAt).toBeNull();

  await vi.advanceTimersByTimeAsync(2 * DAY);

  expect(firings).toHaveLength(0);

  const resumed = await api.runtime.update(
    trigger.id,
    { paused: false },
    "operator"
  );

  expect(resumed.nextFireAt).toBe("2026-11-29T08:00:00.000Z");
});

it("stores webhook events durably and fires them in arrival order with the body appended", async () => {
  const first = await createModule();
  const trigger = await first.api.runtime.create(webhookInput, "operator");

  for (const body of ['{"build":1}', '{"build":2}']) {
    // oxlint-disable-next-line no-await-in-loop -- Events arrive one after another.
    await first.api.runtime.acceptWebhookEvent(trigger.id, {
      body: encoder.encode(body),
      headers: { "content-type": "application/json" },
      receivedAt: START,
    });
  }

  expect(firings).toHaveLength(0);

  await stopModule(first);
  await startModule();

  expect(firings.map((firing) => firing.prompt)).toStrictEqual([
    'Summarize this CI event\n\n{"build":1}',
    'Summarize this CI event\n\n{"build":2}',
  ]);
});

it("rejects a webhook event for a paused or non-webhook Trigger", async () => {
  const { api } = await startModule();

  const webhook = await api.runtime.create(
    { ...webhookInput, paused: true },
    "operator"
  );

  const cron = await api.runtime.create(cronInput("UTC"), "agent");
  const event = { body: new Uint8Array(), headers: {}, receivedAt: START };

  for (const triggerId of [webhook.id, cron.id]) {
    // oxlint-disable-next-line no-await-in-loop -- Each call must reject on its own.
    await expect(
      api.runtime.acceptWebhookEvent(triggerId, event)
    ).rejects.toHaveProperty("code", "not_found");
  }

  await expect(
    api.runtime.webhookTokenSecret(webhook.id)
  ).resolves.toBeUndefined();
});

it("forbids an Agent to create or delete a webhook Trigger", async () => {
  const { api } = await startModule();

  await expect(api.runtime.create(webhookInput, "agent")).rejects.toThrow(
    SeamError
  );

  const webhook = await api.runtime.create(webhookInput, "operator");

  await expect(api.runtime.delete(webhook.id, "agent")).rejects.toHaveProperty(
    "code",
    "forbidden"
  );
  await expect(api.runtime.list()).resolves.toHaveLength(1);
});

it.each([
  ["a four-field expression", "0 8 * *", "UTC"],
  ["an out-of-range minute", "61 8 * * *", "UTC"],
  ["an expression that never matches", "0 0 30 2 *", "UTC"],
  ["an unknown time zone", "0 8 * * *", "Mars/Olympus_Mons"],
])("rejects %s with invalid_name", async (_label, schedule, timezone) => {
  const { api } = await startModule();

  await expect(
    api.runtime.create(
      { ...cronInput("UTC"), schedule: { kind: "cron", schedule, timezone } },
      "operator"
    )
  ).rejects.toHaveProperty("code", "invalid_name");
  await expect(api.runtime.list()).resolves.toStrictEqual([]);
});

it("serves the Operator JSON-RPC methods for every Trigger kind", async () => {
  const { rpc } = await startModule();

  const created = await rpc["triggers.create"]?.(
    { agent: "home", trigger: webhookInput },
    rpcContext
  );

  const triggerId = created?.trigger.id ?? "";

  expect(created?.trigger).toMatchObject({
    createdBy: "operator",
    nextFireAt: null,
    schedule: webhookInput.schedule,
  });

  await expect(
    rpc["triggers.update"]?.(
      { agent: "home", patch: { name: "CI" }, triggerId },
      rpcContext
    )
  ).resolves.toMatchObject({ trigger: { id: triggerId, name: "CI" } });
  await expect(
    rpc["triggers.fire"]?.({ agent: "home", triggerId }, rpcContext)
  ).resolves.toStrictEqual({ runId: "run-1" });
  await expect(
    rpc["triggers.list"]?.({ agent: "home" }, rpcContext)
  ).resolves.toMatchObject({
    triggers: [{ id: triggerId, lastFiredAt: "2026-11-26T10:00:00.000Z" }],
  });
  await expect(
    rpc["triggers.delete"]?.({ agent: "home", triggerId }, rpcContext)
  ).resolves.toStrictEqual({ deleted: true });
  await expect(
    rpc["triggers.fire"]?.({ agent: "home", triggerId }, rpcContext)
  ).rejects.toHaveProperty("code", "not_found");
  expect(changes()).toStrictEqual(["created", "updated", "fired", "deleted"]);
});

it("schedules a reminder for the current Chat through the schedule_trigger Tool", async () => {
  const { api } = await startModule();

  const result = await api.tools.execute(
    "schedule_trigger",
    {
      name: "stretch",
      prompt: "Remind me to stretch",
      schedule: { delay: "15m", kind: "once" },
    },
    toolContext("chat-run")
  );

  expect(result.isError).toBeUndefined();
  await expect(api.runtime.list()).resolves.toMatchObject([
    {
      conversationMode: "per_firing",
      createdBy: "agent",
      nextFireAt: "2026-11-26T10:15:00.000Z",
      schedule: { at: "2026-11-26T10:15:00.000Z", kind: "once" },
      target: { bindingId: "tg", chatId: "1" },
    },
  ]);

  await vi.advanceTimersByTimeAsync(15 * MINUTE);

  expect(firings.map((firing) => firing.prompt)).toStrictEqual([
    "Remind me to stretch",
  ]);
});

it("returns Tool errors for invalid input, a webhook cancel, and a Run without a Chat", async () => {
  const { api } = await startModule();
  const webhook = await api.runtime.create(webhookInput, "operator");

  const invalid = await api.tools.execute(
    "schedule_trigger",
    { name: "x", prompt: "y", schedule: { kind: "webhook" } },
    toolContext("chat-run")
  );

  const badCron = await api.tools.execute(
    "schedule_trigger",
    {
      name: "x",
      prompt: "y",
      schedule: { kind: "cron", schedule: "0 8 * *", timezone: "UTC" },
    },
    toolContext("chat-run")
  );

  const noChat = await api.tools.execute(
    "schedule_trigger",
    { name: "x", prompt: "y", schedule: { delay: "1h", kind: "once" } },
    toolContext("maintenance-run", null)
  );

  const cancel = await api.tools.execute(
    "cancel_trigger",
    { triggerId: webhook.id },
    toolContext("chat-run")
  );

  expect(
    [invalid, badCron, noChat, cancel].map((result) => result.isError)
  ).toStrictEqual([true, true, true, true]);
  expect(textOf(badCron)).toContain("Invalid cron expression");
  expect(textOf(cancel)).toContain("Only the Operator");
  await expect(api.runtime.list()).resolves.toHaveLength(1);
});

it("lists and cancels Triggers through the Tools", async () => {
  const { api } = await startModule();
  const trigger = await api.runtime.create(cronInput("UTC"), "agent");

  const listed = await api.tools.execute("list_triggers", {}, toolContext("r"));

  const cancelled = await api.tools.execute(
    "cancel_trigger",
    { triggerId: trigger.id },
    toolContext("r")
  );

  expect(textOf(listed)).toContain(trigger.id);
  expect(cancelled.isError).toBeUndefined();
  await expect(api.runtime.list()).resolves.toStrictEqual([]);
  expect(api.tools.tools().map((tool) => tool.name)).toStrictEqual([
    "schedule_trigger",
    "list_triggers",
    "cancel_trigger",
    "suppress_delivery",
  ]);
});

it("suppresses delivery only for a Run that a Trigger started", async () => {
  const { api } = await startModule();
  const trigger = await api.runtime.create(cronInput("UTC"), "agent");
  const { runId } = await api.runtime.fire(trigger.id);

  const suppressed = await api.tools.execute(
    "suppress_delivery",
    {},
    toolContext(runId, null)
  );

  const rejected = await api.tools.execute(
    "suppress_delivery",
    {},
    toolContext("chat-run")
  );

  expect(suppressed.isError).toBeUndefined();
  expect(rejected.isError).toBe(true);
  await expect(api.runtime.isDeliverySuppressed(runId)).resolves.toBe(true);
  await expect(api.runtime.isDeliverySuppressed("chat-run")).resolves.toBe(
    false
  );
});

it("starts each firing in a new Conversation by default", async () => {
  const { api } = await startModule();
  const trigger = await api.runtime.create(cronInput("UTC"), "agent");

  await api.runtime.fire(trigger.id);

  expect(firings[0]?.trigger.conversationMode).toBe("per_firing");
});

it("converts a once time with an offset to UTC and rejects a time without an offset", async () => {
  const { api } = await startModule();

  const withOffset = await api.tools.execute(
    "schedule_trigger",
    {
      name: "standup",
      prompt: "Standup",
      schedule: { at: "2026-11-26T12:00:00+01:00", kind: "once" },
    },
    toolContext("chat-run")
  );

  const withoutOffset = await api.tools.execute(
    "schedule_trigger",
    {
      name: "standup",
      prompt: "Standup",
      schedule: { at: "2026-11-26T12:00:00", kind: "once" },
    },
    toolContext("chat-run")
  );

  expect(withOffset.isError).toBeUndefined();
  expect(withoutOffset.isError).toBe(true);
  await expect(api.runtime.list()).resolves.toMatchObject([
    { schedule: { at: "2026-11-26T11:00:00.000Z", kind: "once" } },
  ]);
});
