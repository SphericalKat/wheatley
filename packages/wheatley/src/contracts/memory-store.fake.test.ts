import { describe, expect, it } from "vitest";

import { SeamError } from "./errors.js";
import { InMemoryMemoryStore } from "./memory-store.fake.js";

describe("InMemoryMemoryStore", () => {
  it("rejects a MEMORY.md write over the cap and keeps the old text", async () => {
    const memory = new InMemoryMemoryStore(20);
    await memory.write("MEMORY", "likes tea", "replace");

    await expect(
      memory.write("MEMORY", "and a very long note", "append")
    ).rejects.toMatchObject({
      code: "memory_budget_exceeded",
    });
    await expect(memory.snapshot()).resolves.toStrictEqual({
      text: "likes tea",
      truncated: false,
    });
  });

  it("rejects names that could leave the memory folder", async () => {
    const memory = new InMemoryMemoryStore();

    await expect(memory.write("../secrets", "x", "replace")).rejects.toThrow(
      SeamError
    );
  });

  it("searches files and the archive, and purges a Conversation", async () => {
    const memory = new InMemoryMemoryStore();
    await memory.write("travel", "Prefers window seats on trains", "replace");
    await memory.archive({
      at: 0,
      conversationId: "c1",
      role: "user",
      text: "Book a train to Lyon",
    });

    const hits = await memory.search("train", { limit: 10, scope: "all" });

    expect(hits.map((hit) => hit.kind).toSorted()).toStrictEqual([
      "conversation",
      "memory",
    ]);
    await expect(memory.purgeConversation("c1")).resolves.toBe(1);
    await expect(
      memory.search("train", { limit: 10, scope: "conversations" })
    ).resolves.toStrictEqual([]);
  });
});
