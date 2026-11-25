import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { JsonValue } from "@wheatley/protocol";
import type { ToolContext, ToolResult } from "@wheatley/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ModuleInstance } from "../contracts/module.js";
import { formatSnapshotPrompt } from "./module.js";
import type { MemoryApi } from "./module.js";
import { createMemoryFixture, rpcContext } from "./test-harness.js";
import type { MemoryFixture } from "./test-harness.js";

const CAP = 4000;

let fixture: MemoryFixture;
let memory: ModuleInstance<MemoryApi>;

const toolContext: ToolContext = {
  agentName: "home",
  chat: null,
  conversationId: "c1",
  log: { debug: () => {}, error: () => {}, info: () => {}, warn: () => {} },
  runId: "run-1",
  signal: new AbortController().signal,
  toolCallId: "call-1",
  workspaceDir: "/workspace",
};

const callTool = async (name: string, input: JsonValue): Promise<ToolResult> =>
  await memory.api.tools.execute(name, input, toolContext);

const textOf = (result: ToolResult): string =>
  result.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");

const onDisk = async (fileName: string): Promise<string> =>
  await readFile(path.join(fixture.memoryDir, fileName), "utf-8");

beforeEach(async () => {
  fixture = await createMemoryFixture();
  memory = await fixture.create();
  await memory.start?.();
});

afterEach(async () => {
  await fixture.dispose();
});

describe("Markdown source of truth", () => {
  it("writes MEMORY.md and topic files to the memory folder and reports them in list", async () => {
    await memory.api.store.write("MEMORY", "Prefers tea.", "replace");
    await memory.api.store.write("MEMORY", "Lives in Lyon.", "append");
    await memory.api.store.write(
      "travel",
      "Window seats on trains.",
      "replace"
    );

    await expect(onDisk("MEMORY.md")).resolves.toBe(
      "Prefers tea.\nLives in Lyon."
    );
    await expect(onDisk("travel.md")).resolves.toBe("Window seats on trains.");

    const { budget, files } = await memory.api.store.list();

    expect(budget).toStrictEqual({ maxChars: CAP, usedChars: 27 });
    expect(files.map((file) => [file.name, file.chars])).toStrictEqual([
      ["MEMORY", 27],
      ["travel", 23],
    ]);
    expect(
      fixture.events.filter((event) => event.name === "memory.changed")
    ).toContainEqual({
      name: "memory.changed",
      payload: { agent: "home", change: "written", name: "travel" },
    });
  });

  it("reads Operator edits on disk and ignores files that are not Memory files", async () => {
    await mkdir(fixture.memoryDir, { recursive: true });
    await writeFile(
      path.join(fixture.memoryDir, "pets.md"),
      "A cat named Miso."
    );
    await writeFile(path.join(fixture.memoryDir, "Notes.md"), "ignored");
    await writeFile(path.join(fixture.memoryDir, "todo.txt"), "ignored");

    await expect(memory.api.store.read("pets")).resolves.toBe(
      "A cat named Miso."
    );

    const { files } = await memory.api.store.list();

    expect(files.map((file) => file.name)).toStrictEqual(["pets"]);
  });

  it("deletes topic files and empties MEMORY.md", async () => {
    await memory.api.store.write("MEMORY", "Prefers tea.", "replace");
    await memory.api.store.write("travel", "Window seats.", "replace");

    await expect(memory.api.store.delete("travel")).resolves.toBe(true);
    await expect(memory.api.store.delete("travel")).resolves.toBe(false);
    await expect(memory.api.store.delete("MEMORY")).resolves.toBe(true);
    await expect(onDisk("MEMORY.md")).resolves.toBe("");
    await expect(memory.api.store.read("travel")).resolves.toBeUndefined();
    await expect(
      memory.api.store.search("window", { limit: 10, scope: "memory" })
    ).resolves.toStrictEqual([]);
  });

  it("rejects names that could leave the memory folder", async () => {
    await expect(
      memory.api.store.write("../secrets", "x", "replace")
    ).rejects.toMatchObject({
      code: "invalid_name",
    });
    await expect(memory.api.store.read("Travel")).rejects.toMatchObject({
      code: "invalid_name",
    });
    await expect(memory.api.store.delete("a/b")).rejects.toMatchObject({
      code: "invalid_name",
    });
  });

  it("keeps every concurrent append", async () => {
    await Promise.all(
      Array.from({ length: 10 }, async (_, index) => {
        await memory.api.store.write("log", `entry ${index}`, "append");
      })
    );

    const content = await onDisk("log.md");
    const lines = content.split("\n");

    expect(lines).toHaveLength(10);
    expect(new Set(lines).size).toBe(10);
  });
});

describe("MEMORY.md character cap", () => {
  it("rejects a write over 4,000 characters and leaves MEMORY.md unchanged", async () => {
    await memory.api.store.write("MEMORY", "a".repeat(CAP - 5), "replace");

    await expect(
      memory.api.store.write("MEMORY", "bbbbbb", "append")
    ).rejects.toMatchObject({
      code: "memory_budget_exceeded",
    });
    await expect(
      memory.api.store.write("MEMORY", "c".repeat(CAP + 1), "replace")
    ).rejects.toMatchObject({
      code: "memory_budget_exceeded",
    });
    await expect(onDisk("MEMORY.md")).resolves.toBe("a".repeat(CAP - 5));
  });

  it("accepts MEMORY.md at exactly the cap and does not cap topic files", async () => {
    await expect(
      memory.api.store.write("MEMORY", "a".repeat(CAP), "replace")
    ).resolves.toMatchObject({
      chars: CAP,
    });
    await expect(
      memory.api.store.write("archive", "b".repeat(CAP * 3), "replace")
    ).resolves.toMatchObject({
      chars: CAP * 3,
    });
  });

  it("uses the configured cap", async () => {
    const small = await fixture.create({ config: { maxChars: 10 } });

    await expect(
      small.api.store.write("MEMORY", "12345678901", "replace")
    ).rejects.toMatchObject({
      code: "memory_budget_exceeded",
    });
    await expect(small.api.store.list()).resolves.toMatchObject({
      budget: { maxChars: 10, usedChars: 0 },
    });
  });
});

describe("FTS5 search", () => {
  it("finds Memory files by stemmed words, best match first", async () => {
    await memory.api.store.write(
      "travel",
      "Prefers window seats on trains. Trains to Lyon twice a month.",
      "replace"
    );
    await memory.api.store.write(
      "food",
      "Allergic to peanuts. Likes a train-station croissant.",
      "replace"
    );
    await memory.api.store.write("work", "Works remotely.", "replace");

    const hits = await memory.api.store.search("train", {
      limit: 10,
      scope: "memory",
    });

    expect(
      hits.map((hit) => (hit.kind === "memory" ? hit.name : hit.conversationId))
    ).toStrictEqual(["travel", "food"]);
    expect(hits[0]?.snippet).toContain("trains");
  });

  it("searches the Conversation archive and filters by scope", async () => {
    await memory.api.store.write("travel", "Lyon trips by train.", "replace");
    await memory.api.store.archive({
      at: Date.UTC(2026, 10, 1),
      conversationId: "c1",
      role: "user",
      text: "Book me a train to Lyon",
    });
    await memory.api.store.archive({
      at: Date.UTC(2026, 10, 2),
      conversationId: "c1",
      role: "assistant",
      text: "Done, the ticket is booked.",
    });

    const all = await memory.api.store.search("Lyon", {
      limit: 10,
      scope: "all",
    });

    expect(all.map((hit) => hit.kind).toSorted()).toStrictEqual([
      "conversation",
      "memory",
    ]);
    await expect(
      memory.api.store.search("Lyon", { limit: 10, scope: "conversations" })
    ).resolves.toMatchObject([
      {
        at: "2026-11-01T00:00:00.000Z",
        conversationId: "c1",
        kind: "conversation",
        role: "user",
        snippet: "Book me a train to Lyon",
      },
    ]);
    await expect(
      memory.api.store.search("ticket", { limit: 10, scope: "memory" })
    ).resolves.toStrictEqual([]);
  });

  it("treats FTS5 operators and punctuation in a query as plain words", async () => {
    await memory.api.store.write("travel", "Window seats.", "replace");

    await expect(
      memory.api.store.search('window" OR (seats* NEAR', {
        limit: 10,
        scope: "all",
      })
    ).resolves.toHaveLength(1);
    await expect(
      memory.api.store.search("?!", { limit: 10, scope: "all" })
    ).resolves.toStrictEqual([]);
  });

  it("applies the limit across both sources", async () => {
    await memory.api.store.write("a", "coffee", "replace");
    await memory.api.store.write("b", "coffee coffee", "replace");
    await memory.api.store.archive({
      at: 0,
      conversationId: "c1",
      role: "user",
      text: "coffee please",
    });

    await expect(
      memory.api.store.search("coffee", { limit: 2, scope: "all" })
    ).resolves.toHaveLength(2);
  });
});

describe("index rebuild from disk", () => {
  it("picks up Operator edits on reindex and drops removed files", async () => {
    await memory.api.store.write("travel", "Window seats.", "replace");
    await writeFile(
      path.join(fixture.memoryDir, "pets.md"),
      "A cat named Miso."
    );
    await rm(path.join(fixture.memoryDir, "travel.md"));

    await expect(
      memory.api.store.search("Miso", { limit: 10, scope: "memory" })
    ).resolves.toStrictEqual([]);
    await expect(memory.api.store.reindex()).resolves.toBe(1);
    await expect(
      memory.api.store.search("Miso", { limit: 10, scope: "memory" })
    ).resolves.toMatchObject([{ kind: "memory", name: "pets" }]);
    await expect(
      memory.api.store.search("window", { limit: 10, scope: "memory" })
    ).resolves.toStrictEqual([]);
  });

  it("rebuilds the index when the module starts, as on Agent restart", async () => {
    await mkdir(fixture.memoryDir, { recursive: true });
    await writeFile(
      path.join(fixture.memoryDir, "garden.md"),
      "Tomatoes in the greenhouse."
    );

    const restarted = await fixture.create();

    await restarted.start?.();

    await expect(
      restarted.api.store.search("tomato", { limit: 10, scope: "memory" })
    ).resolves.toMatchObject([{ name: "garden" }]);
    expect(fixture.events.at(-1)).toStrictEqual({
      name: "memory.changed",
      payload: { agent: "home", change: "reindexed" },
    });
  });
});

describe("frozen MEMORY.md snapshot", () => {
  it("keeps the snapshot of a Conversation until refresh, as after /compact", async () => {
    await memory.api.store.write("MEMORY", "Prefers tea.", "replace");

    await expect(memory.api.snapshots.get("c1")).resolves.toStrictEqual({
      text: "Prefers tea.",
      truncated: false,
    });

    await callTool("memory_write", {
      content: "Lives in Lyon.",
      mode: "append",
      name: "MEMORY",
    });

    await expect(memory.api.snapshots.get("c1")).resolves.toStrictEqual({
      text: "Prefers tea.",
      truncated: false,
    });
    await expect(memory.api.snapshots.get("c2")).resolves.toStrictEqual({
      text: "Prefers tea.\nLives in Lyon.",
      truncated: false,
    });
    await expect(memory.api.snapshots.refresh("c1")).resolves.toStrictEqual({
      text: "Prefers tea.\nLives in Lyon.",
      truncated: false,
    });
    await expect(memory.api.snapshots.get("c1")).resolves.toStrictEqual({
      text: "Prefers tea.\nLives in Lyon.",
      truncated: false,
    });
  });

  it("keeps the frozen snapshot across a restart and takes a new one after forget", async () => {
    await memory.api.store.write("MEMORY", "v1", "replace");
    await memory.api.snapshots.get("c1");
    await memory.api.store.write("MEMORY", "v2", "replace");

    const restarted = await fixture.create();

    await expect(restarted.api.snapshots.get("c1")).resolves.toMatchObject({
      text: "v1",
    });

    await restarted.api.snapshots.forget("c1");

    await expect(restarted.api.snapshots.get("c1")).resolves.toMatchObject({
      text: "v2",
    });
  });

  it("cuts an over-long MEMORY.md from disk and says so in the prompt", async () => {
    await mkdir(fixture.memoryDir, { recursive: true });
    await writeFile(
      path.join(fixture.memoryDir, "MEMORY.md"),
      "x".repeat(CAP + 10)
    );

    const snapshot = await memory.api.snapshots.get("c1");

    expect(snapshot.text).toHaveLength(CAP);
    expect(snapshot.truncated).toBe(true);
    expect(formatSnapshotPrompt(snapshot)).toContain("is cut");
    expect(formatSnapshotPrompt({ text: "", truncated: false })).toBe("");
  });
});

describe("Conversation archive purge", () => {
  it("removes one Conversation's messages from the archive and its index", async () => {
    await memory.api.store.archive({
      at: 1,
      conversationId: "c1",
      role: "user",
      text: "secret plan",
    });
    await memory.api.store.archive({
      at: 2,
      conversationId: "c1",
      role: "assistant",
      text: "noted the plan",
    });
    await memory.api.store.archive({
      at: 3,
      conversationId: "c2",
      role: "user",
      text: "another plan",
    });

    await expect(
      memory.rpc["memory.purgeConversation"]?.(
        { agent: "home", conversationId: "c1" },
        rpcContext
      )
    ).resolves.toStrictEqual({ purgedMessages: 2 });

    const hits = await memory.api.store.search("plan", {
      limit: 10,
      scope: "conversations",
    });

    expect(hits).toMatchObject([
      { conversationId: "c2", kind: "conversation" },
    ]);
    await expect(memory.api.store.purgeConversation("c1")).resolves.toBe(0);
  });
});

describe("memory Tools", () => {
  it("offers four built-in Tools with the default action allow", () => {
    expect(
      memory.api.tools
        .tools()
        .map((tool) => [tool.name, tool.source, tool.defaultAction])
    ).toStrictEqual([
      ["memory_search", "builtin", "allow"],
      ["memory_read", "builtin", "allow"],
      ["memory_write", "builtin", "allow"],
      ["memory_delete", "builtin", "allow"],
    ]);
  });

  it("writes, reads, searches, and deletes through the Tools", async () => {
    await expect(
      callTool("memory_write", {
        content: "Window seats on trains.",
        name: "travel",
      })
    ).resolves.toStrictEqual({
      content: [{ text: "Saved travel.md (23 characters).", type: "text" }],
    });
    await expect(onDisk("travel.md")).resolves.toBe("Window seats on trains.");

    expect(textOf(await callTool("memory_read", { name: "travel" }))).toBe(
      "Window seats on trains."
    );
    expect(textOf(await callTool("memory_read", {}))).toContain(
      "travel.md: 23 characters"
    );
    expect(
      textOf(await callTool("memory_search", { query: "train" }))
    ).toContain('memory_read name "travel"');
    expect(textOf(await callTool("memory_delete", { name: "travel" }))).toBe(
      "Deleted travel.md."
    );
    await expect(
      callTool("memory_read", { name: "travel" })
    ).resolves.toMatchObject({ isError: true });
  });

  it("returns an error result with guidance for a MEMORY.md write over the cap", async () => {
    const result = await callTool("memory_write", {
      content: "a".repeat(CAP + 1),
      name: "MEMORY",
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("topic file");
    await expect(memory.api.store.read("MEMORY")).resolves.toBeUndefined();
  });

  it("returns an error result for invalid input and unknown Tools", async () => {
    await expect(
      callTool("memory_write", { content: "x", name: "../x" })
    ).resolves.toMatchObject({
      isError: true,
    });
    await expect(
      callTool("memory_search", { query: "" })
    ).resolves.toMatchObject({ isError: true });
    await expect(
      callTool("memory_read", { name: "a", extra: 1 })
    ).resolves.toMatchObject({ isError: true });
    await expect(callTool("memory_forget", {})).resolves.toMatchObject({
      isError: true,
    });
  });
});

describe("Operator JSON-RPC handlers", () => {
  it("lists, writes, reads, searches, and deletes Memory files", async () => {
    await expect(
      memory.rpc["memory.write"]?.(
        { agent: "home", content: "Prefers tea.", name: "MEMORY" },
        rpcContext
      )
    ).resolves.toMatchObject({ file: { chars: 12, name: "MEMORY" } });
    await expect(
      memory.rpc["memory.read"]?.({ agent: "home", name: "MEMORY" }, rpcContext)
    ).resolves.toStrictEqual({
      content: "Prefers tea.",
      name: "MEMORY",
    });
    await expect(
      memory.rpc["memory.list"]?.({ agent: "home" }, rpcContext)
    ).resolves.toMatchObject({
      budget: { maxChars: CAP, usedChars: 12 },
    });
    await expect(
      memory.rpc["memory.search"]?.({ agent: "home", query: "tea" }, rpcContext)
    ).resolves.toMatchObject({
      hits: [{ kind: "memory", name: "MEMORY" }],
    });
    await expect(
      memory.rpc["memory.reindex"]?.({ agent: "home" }, rpcContext)
    ).resolves.toStrictEqual({ files: 1 });
    await expect(
      memory.rpc["memory.delete"]?.(
        { agent: "home", name: "MEMORY" },
        rpcContext
      )
    ).resolves.toStrictEqual({
      deleted: true,
    });
  });

  it("reports a missing file and an over-cap write as seam errors", async () => {
    await expect(
      memory.rpc["memory.read"]?.({ agent: "home", name: "nope" }, rpcContext)
    ).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      memory.rpc["memory.write"]?.(
        { agent: "home", content: "a".repeat(CAP + 1), name: "MEMORY" },
        rpcContext
      )
    ).rejects.toMatchObject({ code: "memory_budget_exceeded" });
  });
});

describe("pre-compaction flush", () => {
  it("returns a prompt that tells the model to save facts with memory_write", () => {
    const prompt = memory.api.store.compactionFlushPrompt();

    expect(prompt).toContain("memory_write");
    expect(prompt).toContain(String(CAP));
  });
});
