import type { DatabaseSync } from "node:sqlite";

import type { EventName, EventPayload } from "@wheatley-ai/protocol";
import { DeliveryError } from "@wheatley-ai/sdk";
import type { Delivery } from "@wheatley-ai/sdk";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type {
  DeliveryOutbox,
  OutboxEntry,
  OutboxItem,
} from "../contracts/delivery-outbox.js";
import { migrationNamespace } from "../contracts/module.js";
import type {
  AgentModuleContext,
  ModuleInstance,
} from "../contracts/module.js";
import { openAgentDatabase } from "../db/database.js";
import { runMigrations } from "../db/migrations.js";
import { deliveryOutboxModule } from "./module.js";

const START = Date.parse("2026-11-26T10:00:00.000Z");
const SECOND = 1000;
const HOUR = 60 * 60 * SECOND;
const rpcContext = { connectionId: "c1", signal: new AbortController().signal };

type Deliver = (bindingId: string, delivery: Delivery) => Promise<void>;

let db: DatabaseSync;

let events: {
  readonly name: EventName;
  readonly payload: EventPayload<EventName>;
}[];

let delivered: { readonly bindingId: string; readonly delivery: Delivery }[];
let copied: OutboxEntry[];
let deliver: Deliver;
let instances: ModuleInstance<DeliveryOutbox>[];

const message = (
  chatId: string,
  text: string,
  sourceConversationId?: string
): OutboxItem => ({
  bindingId: "tg",
  chatId,
  delivery: { kind: "message", source: "trigger", text },
  sourceConversationId,
});

const createModule = async (): Promise<ModuleInstance<DeliveryOutbox>> => {
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

  const instance = await deliveryOutboxModule.create(ctx, {
    deliver: async (bindingId, delivery) => {
      await deliver(bindingId, delivery);
      delivered.push({ bindingId, delivery });
    },
    onDelivered: async (entry) => {
      await Promise.resolve();
      copied.push(entry);
    },
    random: () => 0,
  });

  instances.push(instance);

  return instance;
};

const startModule = async (): Promise<ModuleInstance<DeliveryOutbox>> => {
  const instance = await createModule();
  await instance.start?.();
  await vi.advanceTimersByTimeAsync(0);

  return instance;
};

const textsOf = (chatId: string): string[] =>
  delivered.flatMap(({ delivery }) =>
    delivery.kind === "message" && delivery.chatId === chatId
      ? [delivery.text]
      : []
  );

const eventNames = (): EventName[] => events.map(({ name }) => name);

beforeEach(() => {
  vi.useFakeTimers({ now: START });
  db = openAgentDatabase(":memory:");
  runMigrations(db, [migrationNamespace(deliveryOutboxModule)]);
  events = [];
  delivered = [];
  copied = [];
  deliver = async () => {
    await Promise.resolve();
  };

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

it("delivers in FIFO order per Chat and assigns the outbox ID as messageId", async () => {
  const { api } = await startModule();

  const first = await api.enqueue(message("1", "one"));
  await api.enqueue(message("1", "two"));
  await api.enqueue(message("1", "three"));
  await vi.advanceTimersByTimeAsync(0);

  expect(textsOf("1")).toStrictEqual(["one", "two", "three"]);
  expect(delivered[0]?.delivery).toMatchObject({
    chatId: "1",
    messageId: first.deliveryId,
  });
});

it("keeps entries that were enqueued while the Agent was down and delivers them at start", async () => {
  const stopped = await createModule();
  await stopped.api.enqueue(message("1", "while down"));
  await stopped.stop?.();

  expect(delivered).toHaveLength(0);

  await startModule();

  expect(textsOf("1")).toStrictEqual(["while down"]);
});

it("retries a retryable error with exponential backoff and copies the result only on confirmed delivery", async () => {
  let failures = 2;
  deliver = async () => {
    await Promise.resolve();

    if (failures > 0) {
      failures -= 1;
      throw new DeliveryError("HTTP 502", { kind: "retryable" });
    }
  };

  const { api } = await startModule();
  await api.enqueue(message("1", "result", "trigger-conversation"));
  await vi.advanceTimersByTimeAsync(0);

  expect(delivered).toHaveLength(0);
  expect(copied).toHaveLength(0);

  // With jitter 0, the backoff after attempt n is 0.5 s * 2^(n-1).
  await vi.advanceTimersByTimeAsync(SECOND / 2);

  expect(delivered).toHaveLength(0);
  expect(copied).toHaveLength(0);

  await vi.advanceTimersByTimeAsync(SECOND);

  expect(textsOf("1")).toStrictEqual(["result"]);
  expect(copied).toMatchObject([
    {
      attempts: 3,
      sourceConversationId: "trigger-conversation",
      status: "delivered",
    },
  ]);
  expect(eventNames()).not.toContain("delivery.failed");
});

it("does not copy a result without a source Conversation", async () => {
  const { api } = await startModule();
  await api.enqueue(message("1", "plain reply"));
  await vi.advanceTimersByTimeAsync(0);

  expect(textsOf("1")).toStrictEqual(["plain reply"]);
  expect(copied).toHaveLength(0);
});

it("honors retryAfterMs from the Frontend", async () => {
  let failed = false;
  deliver = async () => {
    await Promise.resolve();

    if (!failed) {
      failed = true;
      throw new DeliveryError("HTTP 429", {
        kind: "retryable",
        retryAfterMs: 30 * SECOND,
      });
    }
  };

  const { api } = await startModule();
  await api.enqueue(message("1", "rate limited"));
  await vi.advanceTimersByTimeAsync(29 * SECOND);

  expect(delivered).toHaveLength(0);

  await vi.advanceTimersByTimeAsync(SECOND);

  expect(textsOf("1")).toStrictEqual(["rate limited"]);
});

it("blocks a Chat behind its retrying head but delivers other Chats", async () => {
  deliver = async (_bindingId, delivery) => {
    await Promise.resolve();

    if (delivery.kind === "message" && delivery.text === "stuck") {
      throw new Error("socket hang up");
    }
  };

  const { api } = await startModule();
  await api.enqueue(message("1", "stuck"));
  await api.enqueue(message("1", "behind"));
  await api.enqueue(message("2", "other chat"));
  await vi.advanceTimersByTimeAsync(10 * SECOND);

  expect(textsOf("1")).toStrictEqual([]);
  expect(textsOf("2")).toStrictEqual(["other chat"]);
});

it("fails a permanent error at once, emits delivery.failed, and never copies", async () => {
  deliver = async () => {
    await Promise.resolve();
    throw new DeliveryError("chat not found", { kind: "permanent" });
  };

  const { api, rpc } = await startModule();
  const entry = await api.enqueue(message("1", "gone", "trigger-conversation"));
  await vi.advanceTimersByTimeAsync(0);

  const failed = await rpc["deliveries.listFailed"]?.(
    { agent: "home" },
    rpcContext
  );

  expect(failed?.deliveries).toStrictEqual([
    {
      agent: "home",
      attempts: 1,
      bindingId: "tg",
      chatId: "1",
      createdAt: "2026-11-26T10:00:00.000Z",
      deliveryId: entry.deliveryId,
      failedAt: "2026-11-26T10:00:00.000Z",
      kind: "message",
      lastError: "chat not found",
      permanent: true,
      preview: "gone",
    },
  ]);
  expect(events).toContainEqual({
    name: "delivery.failed",
    payload: { agent: "home", delivery: failed?.deliveries[0] },
  });
  expect(copied).toHaveLength(0);
});

it("lets a failed entry stop blocking newer entries of its Chat", async () => {
  deliver = async (_bindingId, delivery) => {
    await Promise.resolve();

    if (delivery.kind === "message" && delivery.text === "bad") {
      throw new DeliveryError("blocked", { kind: "permanent" });
    }
  };

  const { api } = await startModule();
  await api.enqueue(message("1", "bad"));
  await api.enqueue(message("1", "good"));
  await vi.advanceTimersByTimeAsync(0);

  expect(textsOf("1")).toStrictEqual(["good"]);
});

it("fails after 10 retryable attempts", async () => {
  let attempts = 0;
  deliver = async () => {
    await Promise.resolve();
    attempts += 1;
    throw new Error("network down");
  };

  const { api } = await startModule();
  await api.enqueue(message("1", "never"));
  await vi.advanceTimersByTimeAsync(2 * HOUR);

  expect(attempts).toBe(10);
  await expect(api.listFailed()).resolves.toMatchObject([
    { attempts: 10, lastError: "network down", permanent: false },
  ]);
  expect(
    eventNames().filter((name) => name === "delivery.failed")
  ).toHaveLength(1);
});

it("fails a retryable entry whose next attempt would pass the 24-hour window", async () => {
  deliver = async () => {
    await Promise.resolve();
    throw new DeliveryError("HTTP 429", {
      kind: "retryable",
      retryAfterMs: 25 * HOUR,
    });
  };

  const { api } = await startModule();
  await api.enqueue(message("1", "too late"));
  await vi.advanceTimersByTimeAsync(0);

  await expect(api.listFailed()).resolves.toMatchObject([
    { attempts: 1, permanent: false },
  ]);
});

it("retries a failed entry through JSON-RPC with a fresh budget and delivers it", async () => {
  let fail = true;
  deliver = async () => {
    await Promise.resolve();

    if (fail) {
      throw new DeliveryError("bot removed", { kind: "permanent" });
    }
  };

  const { api, rpc } = await startModule();

  const entry = await api.enqueue(
    message("1", "again", "trigger-conversation")
  );

  await vi.advanceTimersByTimeAsync(0);

  fail = false;

  await expect(
    rpc["deliveries.retry"]?.(
      { agent: "home", deliveryId: entry.deliveryId },
      rpcContext
    )
  ).resolves.toStrictEqual({ requeued: true });
  await vi.advanceTimersByTimeAsync(0);

  expect(textsOf("1")).toStrictEqual(["again"]);
  expect(copied).toHaveLength(1);
  await expect(api.listFailed()).resolves.toStrictEqual([]);
  expect(events).toContainEqual({
    name: "delivery.cleared",
    payload: { agent: "home", deliveryId: entry.deliveryId, reason: "retried" },
  });
  await expect(
    rpc["deliveries.retry"]?.(
      { agent: "home", deliveryId: entry.deliveryId },
      rpcContext
    )
  ).resolves.toStrictEqual({ requeued: false });
});

it("dismisses a failed entry through JSON-RPC", async () => {
  deliver = async () => {
    await Promise.resolve();
    throw new DeliveryError("chat deleted", { kind: "permanent" });
  };

  const { api, rpc } = await startModule();
  const entry = await api.enqueue(message("1", "drop me"));
  await vi.advanceTimersByTimeAsync(0);

  await expect(
    rpc["deliveries.dismiss"]?.(
      { agent: "home", deliveryId: entry.deliveryId },
      rpcContext
    )
  ).resolves.toStrictEqual({ dismissed: true });
  await expect(api.listFailed()).resolves.toStrictEqual([]);
  expect(events).toContainEqual({
    name: "delivery.cleared",
    payload: {
      agent: "home",
      deliveryId: entry.deliveryId,
      reason: "dismissed",
    },
  });
  await expect(api.dismiss(entry.deliveryId)).resolves.toBe(false);
});

it("keeps attachment bytes, model pickers, and Approval deliveries intact across storage", async () => {
  const modelPicker = {
    current: { id: "claude-sonnet-5-5", provider: "anthropic" },
    models: [
      {
        id: "claude-sonnet-5-5",
        name: "Claude Sonnet 5.5",
        provider: "anthropic",
      },
    ],
  };

  const stopped = await createModule();
  await stopped.api.enqueue({
    bindingId: "tg",
    chatId: "1",
    delivery: {
      attachments: [
        {
          data: new Uint8Array([0, 1, 2, 255]),
          filename: "report.bin",
          kind: "bytes",
          mimeType: "application/octet-stream",
        },
      ],
      kind: "message",
      source: "reply",
      text: "see file",
    },
  });
  await stopped.api.enqueue({
    bindingId: "tg",
    chatId: "1",
    delivery: {
      kind: "message",
      modelPicker,
      source: "command",
      text: "models",
    },
  });
  await stopped.api.enqueue({
    bindingId: "tg",
    chatId: "1",
    delivery: {
      approvalId: "approval-1",
      expiresAt: null,
      inputPreview: "rm -rf /tmp/x",
      kind: "approval_requested",
      runId: "run-1",
      toolName: "shell",
    },
  });
  await stopped.stop?.();

  await startModule();

  expect(delivered.map(({ delivery }) => delivery)).toMatchObject([
    {
      attachments: [{ data: new Uint8Array([0, 1, 2, 255]), kind: "bytes" }],
      kind: "message",
      text: "see file",
    },
    { kind: "message", modelPicker, text: "models" },
    { approvalId: "approval-1", expiresAt: null, kind: "approval_requested" },
  ]);
});
