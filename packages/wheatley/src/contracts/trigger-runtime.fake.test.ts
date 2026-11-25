import type { TriggerInput } from "@wheatley/protocol";
import { beforeEach, describe, expect, it } from "vitest";

import { SeamError } from "./errors.js";
import { InMemoryTriggerRuntime } from "./trigger-runtime.fake.js";
import type { TriggerFiring, WebhookEvent } from "./trigger-runtime.js";

const NOW = Date.parse("2026-11-26T10:00:00.000Z");
const encoder = new TextEncoder();

const cronInput: TriggerInput = {
  name: "morning plan",
  prompt: "Plan the day",
  schedule: { kind: "cron", schedule: "0 8 * * *", timezone: "Europe/Berlin" },
  target: { bindingId: "tg", chatId: "1" },
};

const webhookInput: TriggerInput = {
  name: "CI results",
  prompt: "Summarize this CI event",
  schedule: { kind: "webhook", tokenSecret: "HOOK_TOKEN" },
  target: { bindingId: "slack", chatId: "C1" },
};

const webhookEvent = (body: string): WebhookEvent => ({
  body: encoder.encode(body),
  headers: { "content-type": "application/json" },
  receivedAt: NOW,
});

let firings: TriggerFiring[] = [];
let changes: string[] = [];
let runtime: InMemoryTriggerRuntime;

const expectSeamError = async (
  promise: Promise<unknown>,
  code: SeamError["code"]
): Promise<void> => {
  await expect(promise).rejects.toBeInstanceOf(SeamError);
  await expect(promise).rejects.toHaveProperty("code", code);
};

beforeEach(() => {
  firings = [];
  changes = [];
  runtime = new InMemoryTriggerRuntime(
    "home",
    {
      isActive: () => false,
      start: async (firing) => {
        await Promise.resolve();
        firings.push(firing);

        return { runId: `run-${firings.length}` };
      },
    },
    {
      clock: { now: () => NOW },
      events: {
        emit: (name, payload) => {
          if (name === "trigger.changed" && "triggerId" in payload) {
            changes.push(
              `${payload.agent}:${payload.change}:${payload.triggerId}`
            );
          }
        },
      },
    }
  );
});

describe("InMemoryTriggerRuntime", () => {
  it("creates a Trigger with defaults that get and list return at once", async () => {
    const trigger = await runtime.create(cronInput, "agent");

    expect(trigger).toMatchObject({
      conversationMode: "per_firing",
      createdAt: "2026-11-26T10:00:00.000Z",
      createdBy: "agent",
      lastFiredAt: null,
      name: "morning plan",
      paused: false,
      prompt: "Plan the day",
      schedule: cronInput.schedule,
      target: cronInput.target,
    });
    await expect(runtime.get(trigger.id)).resolves.toStrictEqual(trigger);
    await expect(runtime.list()).resolves.toStrictEqual([trigger]);
    expect(changes).toStrictEqual([`home:created:${trigger.id}`]);
  });

  it("forbids an Agent to create a webhook Trigger and stores nothing", async () => {
    await expectSeamError(runtime.create(webhookInput, "agent"), "forbidden");

    await expect(runtime.list()).resolves.toStrictEqual([]);
    expect(changes).toStrictEqual([]);
  });

  it("applies a patch, keeps absent fields, and emits updated", async () => {
    const trigger = await runtime.create(cronInput, "agent");

    const updated = await runtime.update(
      trigger.id,
      { conversationMode: "shared", paused: true },
      "agent"
    );

    expect(updated).toStrictEqual({
      ...trigger,
      conversationMode: "shared",
      paused: true,
    });
    await expect(runtime.get(trigger.id)).resolves.toStrictEqual(updated);
    expect(changes).toStrictEqual([
      `home:created:${trigger.id}`,
      `home:updated:${trigger.id}`,
    ]);
  });

  it.each([
    ["a cron expression with four fields", "0 8 * *", "Europe/Berlin"],
    ["a cron field with invalid characters", "0 8 * * ?!", "Europe/Berlin"],
    ["an unknown time zone", "0 8 * * *", "Mars/Olympus_Mons"],
  ])(
    "rejects %s with invalid_name on create and update and stores nothing",
    async (_label, schedule, timezone) => {
      const invalid = { kind: "cron", schedule, timezone } as const;

      await expectSeamError(
        runtime.create({ ...cronInput, schedule: invalid }, "operator"),
        "invalid_name"
      );
      await expect(runtime.list()).resolves.toStrictEqual([]);

      const created = await runtime.create(cronInput, "operator");

      await expectSeamError(
        runtime.update(created.id, { schedule: invalid }, "operator"),
        "invalid_name"
      );
      await expect(runtime.get(created.id)).resolves.toStrictEqual(created);
    }
  );

  it("throws not_found when it updates an unknown Trigger", async () => {
    await expectSeamError(
      runtime.update("trigger-404", { paused: true }, "operator"),
      "not_found"
    );
  });

  it("forbids an Agent to change a webhook Trigger or to turn a Trigger into one", async () => {
    const webhook = await runtime.create(webhookInput, "operator");
    const cron = await runtime.create(cronInput, "agent");

    await expectSeamError(
      runtime.update(webhook.id, { prompt: "Ignore CI" }, "agent"),
      "forbidden"
    );
    await expectSeamError(
      runtime.update(cron.id, { schedule: webhookInput.schedule }, "agent"),
      "forbidden"
    );
    await expect(runtime.get(webhook.id)).resolves.toStrictEqual(webhook);
    await expect(runtime.get(cron.id)).resolves.toStrictEqual(cron);
  });

  it("lets the Operator change a webhook Trigger", async () => {
    const webhook = await runtime.create(webhookInput, "operator");

    await expect(
      runtime.update(webhook.id, { prompt: "List failed jobs" }, "operator")
    ).resolves.toMatchObject({ prompt: "List failed jobs" });
  });

  it("deletes a Trigger once, resolves false after that, and emits deleted", async () => {
    const trigger = await runtime.create(cronInput, "agent");

    await expect(runtime.delete(trigger.id, "agent")).resolves.toBe(true);
    await expect(runtime.delete(trigger.id, "agent")).resolves.toBe(false);
    await expect(runtime.get(trigger.id)).resolves.toBeUndefined();
    expect(changes).toStrictEqual([
      `home:created:${trigger.id}`,
      `home:deleted:${trigger.id}`,
    ]);
  });

  it("forbids an Agent to delete a webhook Trigger and keeps it", async () => {
    const webhook = await runtime.create(webhookInput, "operator");

    await expectSeamError(runtime.delete(webhook.id, "agent"), "forbidden");
    await expect(runtime.get(webhook.id)).resolves.toStrictEqual(webhook);
  });

  it("fires a Trigger now: starts a Run for its target, records lastFiredAt, and emits fired", async () => {
    const trigger = await runtime.create(cronInput, "agent");

    await expect(runtime.fire(trigger.id)).resolves.toStrictEqual({
      runId: "run-1",
    });
    expect(firings).toHaveLength(1);
    expect(firings[0]).toMatchObject({
      prompt: "Plan the day",
      target: cronInput.target,
      trigger: { id: trigger.id },
    });
    await expect(runtime.get(trigger.id)).resolves.toMatchObject({
      lastFiredAt: "2026-11-26T10:00:00.000Z",
    });
    expect(changes).toStrictEqual([
      `home:created:${trigger.id}`,
      `home:fired:${trigger.id}`,
    ]);
  });

  it("throws not_found when it fires an unknown Trigger and starts no Run", async () => {
    await expectSeamError(runtime.fire("trigger-404"), "not_found");
    expect(firings).toHaveLength(0);
  });

  it("gives the token secret only for an active webhook Trigger", async () => {
    const webhook = await runtime.create(webhookInput, "operator");

    const paused = await runtime.create(
      { ...webhookInput, name: "paused hook", paused: true },
      "operator"
    );

    const cron = await runtime.create(cronInput, "agent");

    await expect(runtime.webhookTokenSecret(webhook.id)).resolves.toBe(
      "HOOK_TOKEN"
    );
    await expect(
      runtime.webhookTokenSecret(paused.id)
    ).resolves.toBeUndefined();
    await expect(runtime.webhookTokenSecret(cron.id)).resolves.toBeUndefined();
    await expect(
      runtime.webhookTokenSecret("trigger-404")
    ).resolves.toBeUndefined();
  });

  it("runs accepted webhook events in arrival order with the body appended to the prompt", async () => {
    const webhook = await runtime.create(webhookInput, "operator");

    const first = await runtime.acceptWebhookEvent(
      webhook.id,
      webhookEvent('{"build":1}')
    );

    const second = await runtime.acceptWebhookEvent(
      webhook.id,
      webhookEvent('{"build":2}')
    );

    expect(first.eventId).not.toBe(second.eventId);
    expect(firings.map((firing) => firing.prompt)).toStrictEqual([
      'Summarize this CI event\n\n{"build":1}',
      'Summarize this CI event\n\n{"build":2}',
    ]);
    expect(firings.map((firing) => firing.target)).toStrictEqual([
      webhookInput.target,
      webhookInput.target,
    ]);
    expect(new Set(firings.map((firing) => firing.firingId)).size).toBe(2);
  });

  it("throws not_found for a webhook event to a Trigger that is not an active webhook Trigger", async () => {
    const paused = await runtime.create(
      { ...webhookInput, paused: true },
      "operator"
    );

    const cron = await runtime.create(cronInput, "agent");

    for (const triggerId of [paused.id, cron.id, "trigger-404"]) {
      // oxlint-disable-next-line no-await-in-loop -- each call must reject on its own
      await expectSeamError(
        runtime.acceptWebhookEvent(triggerId, webhookEvent("{}")),
        "not_found"
      );
    }

    expect(firings).toHaveLength(0);
  });

  it("reports suppressed delivery only for a Trigger Run that called suppress_delivery", async () => {
    const trigger = await runtime.create(cronInput, "agent");
    const suppressed = await runtime.fire(trigger.id);
    const delivered = await runtime.fire(trigger.id);

    await expect(runtime.suppressDelivery("run-chat")).resolves.toBe(false);
    await expect(runtime.suppressDelivery(suppressed.runId)).resolves.toBe(
      true
    );

    await expect(runtime.isDeliverySuppressed(suppressed.runId)).resolves.toBe(
      true
    );
    await expect(runtime.isDeliverySuppressed(delivered.runId)).resolves.toBe(
      false
    );
    await expect(runtime.isDeliverySuppressed("run-chat")).resolves.toBe(false);
  });

  it("keeps lastFiredAt and emits no fired event when the Run fails to start", async () => {
    const failing = new InMemoryTriggerRuntime(
      "home",
      {
        isActive: () => false,
        start: async () => {
          await Promise.resolve();
          throw new Error("Agent is stopping");
        },
      },
      { clock: { now: () => NOW } }
    );

    const created = await failing.create(cronInput, "operator");

    await expect(failing.fire(created.id)).rejects.toThrow("Agent is stopping");
    await expect(failing.get(created.id)).resolves.toHaveProperty(
      "lastFiredAt",
      null
    );
  });
});
