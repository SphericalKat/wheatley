import { DeliveryError } from "@wheatley-ai/sdk";
import type { Delivery } from "@wheatley-ai/sdk";
import { describe, expect, it } from "vitest";

import {
  InMemoryDeliveryOutbox,
  MAX_DELIVERY_ATTEMPTS,
} from "./delivery-outbox.fake.js";
import type { OutboxEntry } from "./delivery-outbox.js";

const message = (text: string) =>
  ({ kind: "message", source: "trigger", text }) as const;

describe("InMemoryDeliveryOutbox", () => {
  it("delivers FIFO per Chat and copies confirmed Trigger results", async () => {
    const delivered: Delivery[] = [];
    const copied: OutboxEntry[] = [];

    const outbox = new InMemoryDeliveryOutbox("home", {
      deliver: async (_bindingId, delivery) => {
        await Promise.resolve();
        delivered.push(delivery);
      },
      onDelivered: async (entry) => {
        await Promise.resolve();
        copied.push(entry);
      },
    });

    await outbox.enqueue({
      bindingId: "tg",
      chatId: "1",
      delivery: message("first"),
      sourceConversationId: "c1",
    });
    await outbox.enqueue({
      bindingId: "tg",
      chatId: "1",
      delivery: message("second"),
    });

    await outbox.drain();
    await outbox.drain();

    expect(
      delivered.map((delivery) =>
        delivery.kind === "message" ? delivery.text : ""
      )
    ).toStrictEqual(["first", "second"]);
    expect(delivered[0]).toMatchObject({
      chatId: "1",
      messageId: "delivery-1",
    });
    expect(copied.map((entry) => entry.deliveryId)).toStrictEqual([
      "delivery-1",
    ]);
  });

  it("fails a permanent error at once and stops blocking the Chat", async () => {
    const outbox = new InMemoryDeliveryOutbox("home", {
      deliver: async (_bindingId, delivery) => {
        await Promise.resolve();

        if (delivery.kind === "message" && delivery.text === "lost") {
          throw new DeliveryError("chat deleted", { kind: "permanent" });
        }
      },
      onDelivered: async () => {},
    });

    await outbox.enqueue({
      bindingId: "tg",
      chatId: "1",
      delivery: message("lost"),
    });
    await outbox.enqueue({
      bindingId: "tg",
      chatId: "1",
      delivery: message("next"),
    });
    await outbox.drain();
    await outbox.drain();

    expect(outbox.entries.map((entry) => entry.status)).toStrictEqual([
      "failed",
      "delivered",
    ]);
    await expect(outbox.listFailed()).resolves.toMatchObject([
      {
        attempts: 1,
        deliveryId: "delivery-1",
        lastError: "chat deleted",
        permanent: true,
      },
    ]);
  });

  it("retries a retryable error until the attempt limit, then allows a manual retry or dismissal", async () => {
    const outbox = new InMemoryDeliveryOutbox("home", {
      deliver: async () => {
        await Promise.resolve();
        throw new Error("network down");
      },
      onDelivered: async () => {},
    });

    await outbox.enqueue({
      bindingId: "tg",
      chatId: "1",
      delivery: message("hello"),
    });

    for (let attempt = 1; attempt < MAX_DELIVERY_ATTEMPTS; attempt += 1) {
      // oxlint-disable-next-line no-await-in-loop -- Each drain is one attempt in sequence.
      await outbox.drain();
    }

    expect(outbox.entries[0]?.status).toBe("pending");
    await outbox.drain();
    expect(outbox.entries[0]?.status).toBe("failed");

    await expect(outbox.retry("delivery-1")).resolves.toBe(true);
    expect(outbox.entries[0]).toMatchObject({ attempts: 0, status: "pending" });
    await expect(outbox.dismiss("delivery-1")).resolves.toBe(false);
  });

  it("keeps an entry delivered when the copy into the Chat's Conversation fails", async () => {
    let deliveries = 0;

    const outbox = new InMemoryDeliveryOutbox("home", {
      deliver: async () => {
        await Promise.resolve();
        deliveries += 1;
      },
      onDelivered: async () => {
        await Promise.resolve();
        throw new Error("conversation store down");
      },
    });

    await outbox.enqueue({
      bindingId: "tg",
      chatId: "1",
      delivery: message("result"),
      sourceConversationId: "c1",
    });
    await outbox.drain();
    await outbox.drain();

    expect(deliveries).toBe(1);
    expect(outbox.entries[0]?.status).toBe("delivered");
    expect(outbox.copyErrors).toHaveLength(1);
  });

  it("emits delivery.failed for a failed entry and delivery.cleared for a retry and a dismissal", async () => {
    const emitted: unknown[] = [];

    const outbox = new InMemoryDeliveryOutbox(
      "home",
      {
        deliver: async () => {
          await Promise.resolve();
          throw new DeliveryError("bot removed", { kind: "permanent" });
        },
        onDelivered: async () => {},
      },
      {
        clock: { now: () => 0 },
        events: {
          emit: (name, payload) => {
            emitted.push({ name, payload });
          },
        },
      }
    );

    await outbox.enqueue({
      bindingId: "tg",
      chatId: "1",
      delivery: message("hello"),
    });
    await outbox.drain();
    await outbox.retry("delivery-1");
    await outbox.drain();
    await outbox.dismiss("delivery-1");

    expect(emitted).toStrictEqual([
      {
        name: "delivery.failed",
        payload: {
          agent: "home",
          delivery: {
            agent: "home",
            attempts: 1,
            bindingId: "tg",
            chatId: "1",
            createdAt: "1970-01-01T00:00:00.000Z",
            deliveryId: "delivery-1",
            failedAt: "1970-01-01T00:00:00.000Z",
            kind: "message",
            lastError: "bot removed",
            permanent: true,
            preview: "hello",
          },
        },
      },
      {
        name: "delivery.cleared",
        payload: { agent: "home", deliveryId: "delivery-1", reason: "retried" },
      },
      expect.objectContaining({ name: "delivery.failed" }),
      {
        name: "delivery.cleared",
        payload: {
          agent: "home",
          deliveryId: "delivery-1",
          reason: "dismissed",
        },
      },
    ]);
  });
});
