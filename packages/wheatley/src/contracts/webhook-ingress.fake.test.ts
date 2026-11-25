import type { AgentState } from "@wheatley-ai/protocol";
import { beforeEach, describe, expect, it } from "vitest";

import { SeamError } from "./errors.js";
import { InMemorySecretStore } from "./secret-store.fake.js";
import { InMemoryTriggerRuntime } from "./trigger-runtime.fake.js";
import type { TriggerFiring } from "./trigger-runtime.js";
import { InMemoryWebhookIngress } from "./webhook-ingress.fake.js";
import type { IngressRequest } from "./webhook-ingress.js";

const encoder = new TextEncoder();

let state: AgentState = "running";
let firings: TriggerFiring[] = [];
let triggers: InMemoryTriggerRuntime;
let ingress: InMemoryWebhookIngress;
let triggerId = "";

const post = (
  path: string,
  headers: Readonly<Record<string, string>> = {}
): IngressRequest => ({
  body: encoder.encode('{"event":"push"}'),
  headers,
  method: "POST",
  path,
  query: {},
});

beforeEach(async () => {
  state = "running";
  firings = [];
  triggers = new InMemoryTriggerRuntime("home", {
    isActive: () => false,
    start: async (firing) => {
      await Promise.resolve();
      firings.push(firing);

      return { runId: `run-${firings.length}` };
    },
  });
  ingress = new InMemoryWebhookIngress({
    agent: (name) =>
      name === "home"
        ? {
            state: () => state,
            triggers: () => (state === "running" ? triggers : undefined),
          }
        : undefined,
    secrets: new InMemorySecretStore({ HOOK_TOKEN: "s3cret-token" }),
  });

  const trigger = await triggers.create(
    {
      name: "CI results",
      prompt: "Summarize this CI event",
      schedule: { kind: "webhook", tokenSecret: "HOOK_TOKEN" },
      target: { bindingId: "tg", chatId: "1" },
    },
    "operator"
  );

  triggerId = trigger.id;
});

describe("InMemoryWebhookIngress for Trigger webhooks", () => {
  it("accepts an authorized request with 202 and fires the Trigger with the body", async () => {
    const response = await ingress.handle(
      post(`/webhooks/home/${triggerId}`, {
        authorization: "Bearer s3cret-token",
      })
    );

    expect(response.status).toBe(202);
    expect(firings[0]?.prompt).toBe(
      'Summarize this CI event\n\n{"event":"push"}'
    );
    expect(triggers.webhookEvents[0]?.event.headers).not.toHaveProperty(
      "authorization"
    );
  });

  it.each([
    [
      "a wrong token",
      `/webhooks/home/TRIGGER`,
      { authorization: "Bearer wrong" },
      401,
    ],
    ["a missing token", `/webhooks/home/TRIGGER`, {}, 401],
    [
      "an unknown Trigger",
      "/webhooks/home/trigger-404",
      { authorization: "Bearer s3cret-token" },
      404,
    ],
    [
      "an unknown Agent",
      "/webhooks/office/TRIGGER",
      { authorization: "Bearer s3cret-token" },
      404,
    ],
  ])(
    "answers %s with the documented status",
    async (_label, path, headers, expected) => {
      const response = await ingress.handle(
        post(path.replace("TRIGGER", triggerId), headers)
      );

      expect(response.status).toBe(expected);
      expect(firings).toHaveLength(0);
    }
  );

  it("answers 503 for a degraded Agent without a Trigger runtime, before the Trigger and token checks, and 405 for GET", async () => {
    state = "degraded";

    await expect(
      ingress.handle(
        post(`/webhooks/home/${triggerId}`, {
          authorization: "Bearer s3cret-token",
        })
      )
    ).resolves.toStrictEqual({ status: 503 });
    await expect(
      ingress.handle(post("/webhooks/home/trigger-404"))
    ).resolves.toStrictEqual({ status: 503 });
    await expect(
      ingress.handle({ ...post(`/webhooks/home/${triggerId}`), method: "GET" })
    ).resolves.toStrictEqual({
      status: 405,
    });
  });

  it("forbids an Agent to create a webhook Trigger", async () => {
    await expect(
      triggers.create(
        {
          name: "sneaky",
          prompt: "x",
          schedule: { kind: "webhook", tokenSecret: "HOOK_TOKEN" },
          target: { bindingId: "tg", chatId: "1" },
        },
        "agent"
      )
    ).rejects.toThrow(SeamError);
  });
});

describe("InMemoryTriggerRuntime", () => {
  it("gives each firing its own ID, emits trigger.changed, and records suppress_delivery per Run", async () => {
    const emitted: string[] = [];

    const runtime = new InMemoryTriggerRuntime(
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
        clock: { now: () => 0 },
        events: {
          emit: (name, payload) => {
            emitted.push(
              `${name}:${"change" in payload ? payload.change : ""}`
            );
          },
        },
      }
    );

    const trigger = await runtime.create(
      {
        name: "daily",
        prompt: "Plan the day",
        schedule: { at: "2026-11-27T08:00:00.000Z", kind: "once" },
        target: { bindingId: "tg", chatId: "1" },
      },
      "agent"
    );

    const first = await runtime.fire(trigger.id);
    await runtime.fire(trigger.id);

    expect(new Set(firings.map((firing) => firing.firingId)).size).toBe(2);
    expect(emitted).toStrictEqual([
      "trigger.changed:created",
      "trigger.changed:fired",
      "trigger.changed:fired",
    ]);
    await expect(runtime.suppressDelivery(first.runId)).resolves.toBe(true);
    await expect(runtime.suppressDelivery("run-chat")).resolves.toBe(false);
    await expect(runtime.isDeliverySuppressed(first.runId)).resolves.toBe(true);
    await expect(runtime.isDeliverySuppressed("run-2")).resolves.toBe(false);
  });
});

describe("InMemoryWebhookIngress for Frontend routes", () => {
  it("routes to a registered handler until it unregisters", async () => {
    const route = ingress.registerFrontendRoute(
      "home",
      "telegram-main",
      "updates",
      async (request) => {
        await Promise.resolve();

        return {
          body: `${request.pathSuffix}:${request.headers["x-telegram-bot-api-secret-token"] ?? ""}`,
          status: 200,
        };
      }
    );

    expect(route.path).toBe("/frontends/home/telegram-main/updates");
    await expect(
      ingress.handle(
        post(route.path, { "x-telegram-bot-api-secret-token": "t" })
      )
    ).resolves.toStrictEqual({ body: "updates:t", status: 200 });

    route.unregister();
    await expect(ingress.handle(post(route.path))).resolves.toStrictEqual({
      status: 404,
    });
  });

  it("rejects an unsafe or duplicate path suffix", () => {
    ingress.registerFrontendRoute(
      "home",
      "slack",
      "events",
      async () => await Promise.resolve({ status: 200 })
    );

    expect(() =>
      ingress.registerFrontendRoute(
        "home",
        "slack",
        "events",
        async () => await Promise.resolve({ status: 200 })
      )
    ).toThrow("already mounted");
    expect(() =>
      ingress.registerFrontendRoute(
        "home",
        "slack",
        "../admin",
        async () => await Promise.resolve({ status: 200 })
      )
    ).toThrow(RangeError);
  });
});
