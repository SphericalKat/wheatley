import { once } from "node:events";
import { connect } from "node:net";
import type { Socket } from "node:net";

import { webhookTriggerPath } from "@wheatley-ai/protocol";
import type { AgentState } from "@wheatley-ai/protocol";
import type { WebhookRequest } from "@wheatley-ai/sdk";
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
let logged: { readonly level: string; readonly message: string }[];

const record =
  (level: string) =>
  (message: string): void => {
    logged.push({ level, message });
  };

const startIngress = async (
  enabled: boolean
): Promise<ModuleInstance<WebhookIngressModuleApi>> => {
  const instance = await webhookIngressModule.create(
    {
      clock: { now: () => Date.parse("2026-11-26T10:00:00.000Z") },
      events: { emit: () => {} },
      homeDir: "/data",
      log: {
        debug: () => {},
        error: record("error"),
        info: () => {},
        warn: record("warn"),
      },
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

/** Opens a raw TCP connection to the Ingress and collects what it answers. */
const openSocket = async (): Promise<{
  readonly socket: Socket;
  readonly received: () => string;
  readonly closed: Promise<undefined>;
}> => {
  const address = ingress.api.address();
  const socket = connect(address?.port ?? 0, address?.host);
  const chunks: Buffer[] = [];

  socket.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
  });
  // A server that closes early makes writes fail with EPIPE or ECONNRESET. The tests watch `close` instead.
  socket.on("error", () => {});

  const { promise: closed, resolve } = Promise.withResolvers<undefined>();

  socket.once("close", () => {
    resolve(undefined);
  });

  await once(socket, "connect");

  return {
    closed,
    received: () => Buffer.concat(chunks).toString("latin1"),
    socket,
  };
};

const requestHead = (headers: string): string =>
  `POST ${webhookTriggerPath("home", triggerId)} HTTP/1.1\r\nhost: localhost\r\nauthorization: Bearer ${TOKEN}\r\n${headers}\r\n`;

beforeEach(async () => {
  logged = [];
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
  const response = await post(
    webhookTriggerPath("home", triggerId),
    '{"ok":true}',
    {
      ...bearer,
      "content-type": "application/json",
      "x-github-event": "push",
    }
  );

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
  const response = await post(
    webhookTriggerPath("home", triggerId),
    "{}",
    headers
  );

  expect(response.status).toBe(401);
  expect(runtime.webhookEvents).toHaveLength(0);
});

it("answers 413 for a declared body over 256 KiB", async () => {
  const response = await post(
    webhookTriggerPath("home", triggerId),
    Buffer.alloc(MAX_WEBHOOK_BODY_BYTES + 1),
    bearer
  );

  expect(response.status).toBe(413);
  expect(response.headers.get("connection")).toBe("close");
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

  const response = await fetch(
    `${baseUrl}${webhookTriggerPath("home", triggerId)}`,
    init
  );

  const { status } = response;

  expect(status).toBe(413);
  expect(response.headers.get("connection")).toBe("close");
  expect(runtime.webhookEvents).toHaveLength(0);
});

it("closes the connection after a 413 without reading the rest of a streamed body", async () => {
  /** Far more than the cap. A server that reads to the end accepts all of it. */
  const writeLimit = 64 * MAX_WEBHOOK_BODY_BYTES;
  const chunkSize = 64 * 1024;
  const chunk = `${chunkSize.toString(16)}\r\n${"x".repeat(chunkSize)}\r\n`;
  const { closed, received, socket } = await openSocket();
  let written = 0;
  socket.write(requestHead("transfer-encoding: chunked\r\n"));

  while (socket.writable && written < writeLimit) {
    written += chunkSize;

    if (!socket.write(chunk)) {
      const drained = Promise.withResolvers<undefined>();

      socket.once("drain", () => {
        drained.resolve(undefined);
      });
      // oxlint-disable-next-line no-await-in-loop -- Each write waits for the socket to drain the previous one.
      await Promise.race([drained.promise, closed]);
    }
  }

  await closed;

  expect(received()).toMatch(/^HTTP\/1\.1 413 /u);
  expect(written).toBeLessThan(writeLimit);
  expect(runtime.webhookEvents).toHaveLength(0);
});

it("answers 400 and logs a warning if the client stops before the declared body ends", async () => {
  const { closed, received, socket } = await openSocket();

  socket.end(`${requestHead("content-length: 100\r\n")}{"partial":`);
  await closed;

  expect(received()).toMatch(/^HTTP\/1\.1 400 /u);
  expect(logged).toStrictEqual([
    { level: "warn", message: "A webhook request was not read" },
  ]);
  expect(runtime.webhookEvents).toHaveLength(0);
});

it("accepts a body of exactly 256 KiB", async () => {
  const response = await post(
    webhookTriggerPath("home", triggerId),
    Buffer.alloc(MAX_WEBHOOK_BODY_BYTES),
    bearer
  );

  expect(response.status).toBe(202);
});

it.each(["stopped", "degraded", "starting"] as const)(
  "answers 503 while the Agent is %s",
  async (agentState) => {
    state = agentState;

    const response = await post(
      webhookTriggerPath("home", triggerId),
      "{}",
      bearer
    );

    expect(response.status).toBe(503);
    expect(runtime.webhookEvents).toHaveLength(0);
  }
);

it("answers 404 for an unknown Agent or Trigger and 405 for another method", async () => {
  const unknownAgent = await post(
    webhookTriggerPath("office", triggerId),
    "{}",
    bearer
  );

  const unknownTrigger = await post("/webhooks/home/trigger-404", "{}", bearer);
  const get = await fetch(`${baseUrl}${webhookTriggerPath("home", triggerId)}`);

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
  ).toThrow(expect.objectContaining({ code: "conflict" }));

  expect(() =>
    ingress.api.registerFrontendRoute("home", "slack-main", "", handler)
  ).toThrow(expect.objectContaining({ code: "invalid_name" }));
  expect(() =>
    ingress.api.registerFrontendRoute("home", "slack-main", "../up", handler)
  ).toThrow(expect.objectContaining({ code: "invalid_name" }));
  expect(() =>
    ingress.api.registerFrontendRoute("home", "slack-main", "a?x=1", handler)
  ).toThrow(expect.objectContaining({ code: "invalid_name" }));
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
