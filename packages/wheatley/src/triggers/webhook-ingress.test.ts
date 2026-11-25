import type { AgentState } from "@wheatley/protocol";
import type { WebhookRequest } from "@wheatley/sdk";
import { afterEach, beforeEach, expect, it } from "vitest";

import type { ModuleInstance } from "../contracts/module.js";
import { InMemorySecretStore } from "../contracts/secret-store.fake.js";
import { InMemoryTriggerRuntime } from "../contracts/trigger-runtime.fake.js";
import { MAX_WEBHOOK_BODY_BYTES } from "../contracts/webhook-ingress.js";
import { webhookIngressModule } from "./module.js";
import type { WebhookIngressModuleApi } from "./module.js";

const TOKEN = "s3cret-token";

let state: AgentState;
let runtime: InMemoryTriggerRuntime;
let ingress: ModuleInstance<WebhookIngressModuleApi>;
let baseUrl: string;
let triggerId: string;

const startIngress = async (
  enabled: boolean
): Promise<ModuleInstance<WebhookIngressModuleApi>> => {
  const instance = await webhookIngressModule.create(
    {
      clock: { now: () => Date.parse("2026-11-26T10:00:00.000Z") },
      events: { emit: () => {} },
      homeDir: "/data",
      log: { debug: () => {}, error: () => {}, info: () => {}, warn: () => {} },
    },
    {
      agent: (name) =>
        name === "home"
          ? {
              state: () => state,
              triggers: () => (state === "running" ? runtime : undefined),
            }
          : undefined,
      config: { enabled, host: "127.0.0.1", port: 0 },
      secrets: new InMemorySecretStore({ HOOK_TOKEN: TOKEN }),
    }
  );

  await instance.start?.();

  return instance;
};

const post = async (
  path: string,
  body: BodyInit,
  headers: Record<string, string> = {}
): Promise<Response> =>
  await fetch(`${baseUrl}${path}`, { body, headers, method: "POST" });

const bearer = { authorization: `Bearer ${TOKEN}` };

beforeEach(async () => {
  state = "running";
  runtime = new InMemoryTriggerRuntime("home", {
    isActive: () => false,
    start: async () => {
      await Promise.resolve();

      return { runId: "run-1" };
    },
  });

  const trigger = await runtime.create(
    {
      name: "CI",
      prompt: "Summarize",
      schedule: { kind: "webhook", tokenSecret: "HOOK_TOKEN" },
      target: { bindingId: "slack", chatId: "C1" },
    },
    "operator"
  );

  triggerId = trigger.id;
  ingress = await startIngress(true);

  const address = ingress.api.address();
  baseUrl = `http://${address?.host}:${address?.port}`;
});

afterEach(async () => {
  await ingress.stop?.();
});

it("persists an authorized webhook event and answers 202 Accepted", async () => {
  const response = await post(`/webhooks/home/${triggerId}`, '{"ok":true}', {
    ...bearer,
    "content-type": "application/json",
    "x-github-event": "push",
  });

  expect(response.status).toBe(202);
  expect(runtime.webhookEvents).toHaveLength(1);

  const [stored] = runtime.webhookEvents;

  expect(new TextDecoder().decode(stored?.event.body)).toBe('{"ok":true}');
  expect(stored?.event.headers).toMatchObject({
    "content-type": "application/json",
    "x-github-event": "push",
  });
  expect(stored?.event.headers).not.toHaveProperty("authorization");
});

it.each([
  ["no Authorization header", {}],
  ["a wrong token", { authorization: "Bearer wrong-token" }],
  ["another scheme", { authorization: `Basic ${TOKEN}` }],
])("answers 401 for %s and stores nothing", async (_label, headers) => {
  const response = await post(`/webhooks/home/${triggerId}`, "{}", headers);

  expect(response.status).toBe(401);
  expect(runtime.webhookEvents).toHaveLength(0);
});

it("answers 413 for a declared body over 256 KiB", async () => {
  const response = await post(
    `/webhooks/home/${triggerId}`,
    Buffer.alloc(MAX_WEBHOOK_BODY_BYTES + 1),
    bearer
  );

  expect(response.status).toBe(413);
  expect(runtime.webhookEvents).toHaveLength(0);
});

it("answers 413 for a streamed body that passes 256 KiB without a declared length", async () => {
  const chunk = new Uint8Array(64 * 1024);
  let sent = 0;

  // A stream body has no Content-Length, so the request uses chunked transfer encoding.
  const body = new ReadableStream<Uint8Array>({
    pull: (controller) => {
      if (sent === 5) {
        controller.close();

        return;
      }

      sent += 1;
      controller.enqueue(chunk);
    },
  });

  // Node.js requires `duplex` for a stream body. The DOM `RequestInit` type does not declare it.
  const init: RequestInit & { readonly duplex: "half" } = {
    body,
    duplex: "half",
    headers: bearer,
    method: "POST",
  };

  const response = await fetch(`${baseUrl}/webhooks/home/${triggerId}`, init);

  const { status } = response;

  expect(status).toBe(413);
  expect(runtime.webhookEvents).toHaveLength(0);
});

it("accepts a body of exactly 256 KiB", async () => {
  const response = await post(
    `/webhooks/home/${triggerId}`,
    Buffer.alloc(MAX_WEBHOOK_BODY_BYTES),
    bearer
  );

  expect(response.status).toBe(202);
});

it.each(["stopped", "degraded", "starting"] as const)(
  "answers 503 while the Agent is %s",
  async (agentState) => {
    state = agentState;

    const response = await post(`/webhooks/home/${triggerId}`, "{}", bearer);

    expect(response.status).toBe(503);
    expect(runtime.webhookEvents).toHaveLength(0);
  }
);

it("answers 404 for an unknown Agent or Trigger and 405 for another method", async () => {
  const unknownAgent = await post(
    `/webhooks/office/${triggerId}`,
    "{}",
    bearer
  );

  const unknownTrigger = await post("/webhooks/home/trigger-404", "{}", bearer);
  const get = await fetch(`${baseUrl}/webhooks/home/${triggerId}`);

  expect(unknownAgent.status).toBe(404);
  expect(unknownTrigger.status).toBe(404);
  expect(get.status).toBe(405);
});

it("mounts a Frontend route and forwards the request to its handler", async () => {
  const received: WebhookRequest[] = [];

  const route = ingress.api.registerFrontendRoute(
    "home",
    "telegram-main",
    "updates",
    async (request) => {
      await Promise.resolve();
      received.push(request);

      return { body: "ok", status: 200 };
    }
  );

  const response = await post(
    "/frontends/home/telegram-main/updates?source=tg",
    '{"update_id":1}',
    { "x-telegram-bot-api-secret-token": "abc" }
  );

  expect(route.path).toBe("/frontends/home/telegram-main/updates");
  expect(response.status).toBe(200);
  await expect(response.text()).resolves.toBe("ok");
  expect(received).toHaveLength(1);
  expect(received[0]).toMatchObject({
    headers: { "x-telegram-bot-api-secret-token": "abc" },
    method: "POST",
    pathSuffix: "updates",
    query: { source: "tg" },
  });
  expect(new TextDecoder().decode(received[0]?.body)).toBe('{"update_id":1}');

  state = "stopped";
  const stopped = await post(route.path, "{}");

  expect(stopped.status).toBe(503);

  state = "running";
  route.unregister();
  const unmounted = await post(route.path, "{}");

  expect(unmounted.status).toBe(404);
});

const okHandler = async (): Promise<{ readonly status: number }> => {
  await Promise.resolve();

  return { status: 200 };
};

it("rejects an invalid or duplicate Frontend route suffix", () => {
  const handler = okHandler;

  ingress.api.registerFrontendRoute("home", "slack-main", "events", handler);

  expect(() =>
    ingress.api.registerFrontendRoute("home", "slack-main", "events", handler)
  ).toThrow("already mounted");

  expect(() =>
    ingress.api.registerFrontendRoute("home", "slack-main", "", handler)
  ).toThrow(RangeError);
  expect(() =>
    ingress.api.registerFrontendRoute("home", "slack-main", "../up", handler)
  ).toThrow(RangeError);
  expect(() =>
    ingress.api.registerFrontendRoute("home", "slack-main", "a?x=1", handler)
  ).toThrow(RangeError);
});

it("answers 500 without details if a Frontend handler throws", async () => {
  ingress.api.registerFrontendRoute("home", "discord", "hook", async () => {
    await Promise.resolve();
    throw new Error("secret detail");
  });

  const response = await post("/frontends/home/discord/hook", "{}");

  expect(response.status).toBe(500);
  await expect(response.text()).resolves.toBe("");
});

it("does not listen while webhooks are disabled", async () => {
  const disabled = await startIngress(false);

  expect(disabled.api.enabled).toBe(false);
  expect(disabled.api.address()).toBeUndefined();
  await disabled.stop?.();
});
