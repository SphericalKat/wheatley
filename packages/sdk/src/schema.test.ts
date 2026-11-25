import { setImmediate } from "node:timers/promises";

import { defineTool, isStandardJsonSchema } from "@wheatley/sdk";
import type { JsonSchema, ToolContext } from "@wheatley/sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const context: ToolContext = {
  agentName: "home",
  conversationId: "conversation-1",
  log: { debug: () => {}, error: () => {}, info: () => {}, warn: () => {} },
  runId: "run-1",
  signal: new AbortController().signal,
  toolCallId: "call-1",
  workspaceDir: "/workspace",
};

describe("Tool schemas", () => {
  it("accepts a Zod 4 schema and types execute input from its output", async () => {
    const tool = defineTool({
      description: "Reads a note",
      execute: async (input, ctx) => {
        await setImmediate();
        ctx.signal.throwIfAborted();

        return { content: [{ text: input.path.toUpperCase(), type: "text" }] };
      },
      inputSchema: z.object({ path: z.string() }),
      name: "read_note",
    });

    expect(isStandardJsonSchema(tool.inputSchema)).toBe(true);
    await expect(
      tool.execute({ path: "todo.md" }, context)
    ).resolves.toStrictEqual({
      content: [{ text: "TODO.MD", type: "text" }],
    });
  });

  it("converts a Zod 4 schema to plain JSON Schema through the Standard JSON Schema converter", () => {
    const schema = z.object({ path: z.string() });

    expect(isStandardJsonSchema(schema)).toBe(true);
    expect(
      schema["~standard"].jsonSchema.input({ target: "draft-2020-12" })
    ).toMatchObject({
      properties: { path: { type: "string" } },
      type: "object",
    });
  });

  it("treats a plain JSON Schema object as plain JSON Schema", () => {
    const schema: JsonSchema = {
      properties: { path: { type: "string" } },
      type: "object",
    };

    expect(isStandardJsonSchema(schema)).toBe(false);
  });
});
