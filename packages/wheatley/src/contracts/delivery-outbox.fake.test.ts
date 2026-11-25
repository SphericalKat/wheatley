import { DeliveryError } from "@wheatley/sdk";
import type { Delivery } from "@wheatley/sdk";
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
});
