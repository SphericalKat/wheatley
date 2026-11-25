import {
  isJsonValue,
  MemoryNameSchema,
  MemorySearchScopeSchema,
} from "@wheatley/protocol";
import type {
  ExtensionStatus,
  JsonValue,
  MemorySearchHit,
} from "@wheatley/protocol";
import type { JsonSchema, ToolContext, ToolResult } from "@wheatley/sdk";
import { Type } from "typebox";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";

import type {
  ToolDescriptor,
  ToolProvider,
} from "../contracts/extension-catalog.js";
import type { MemoryStore } from "../contracts/memory-store.js";
import { canonicalToolName } from "../contracts/tool-names.js";
import { errorMessage, fileSizeLine } from "./format.js";
import { MEMORY_NAME, memoryFileName } from "./names.js";

/** The default number of `memory_search` hits. It is lower than the Operator default to save model context. */
const TOOL_SEARCH_LIMIT = 10;

/** The maximum number of `memory_search` hits. */
const MAX_SEARCH_LIMIT = 50;

const strict = { additionalProperties: false } as const;

const SearchInput = Type.Object(
  {
    limit: Type.Optional(
      Type.Integer({ maximum: MAX_SEARCH_LIMIT, minimum: 1 })
    ),
    query: Type.String({ minLength: 1 }),
    scope: Type.Optional(MemorySearchScopeSchema),
  },
  strict
);

const ReadInput = Type.Object(
  { name: Type.Optional(MemoryNameSchema) },
  strict
);

const WriteInput = Type.Object(
  {
    content: Type.String(),
    mode: Type.Optional(
      Type.Union([Type.Literal("replace"), Type.Literal("append")])
    ),
    name: MemoryNameSchema,
  },
  strict
);

const DeleteInput = Type.Object({ name: MemoryNameSchema }, strict);

const textResult = (text: string): ToolResult => ({
  content: [{ text, type: "text" }],
});

const errorResult = (text: string): ToolResult => ({
  content: [{ text, type: "text" }],
  isError: true,
});

const isJsonObject = (value: JsonValue): value is JsonSchema =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Converts a TypeBox schema, which is plain JSON Schema, to the SDK `JsonSchema` type. */
const toJsonSchema = (schema: TSchema): JsonSchema => {
  const value: unknown = structuredClone(schema);

  if (!isJsonValue(value) || !isJsonObject(value)) {
    throw new TypeError("A Tool input schema must be a JSON object");
  }

  return value;
};

const formatHit = (hit: MemorySearchHit): string =>
  hit.kind === "memory"
    ? `- ${memoryFileName(hit.name)} (memory_read name "${hit.name}"): ${hit.snippet}`
    : `- Conversation ${hit.conversationId}, ${hit.role} at ${hit.at}: ${hit.snippet}`;

/** One memory Tool: its schema and a handler for validated input. */
interface MemoryTool<Schema extends TSchema> {
  readonly name: string;
  readonly description: string;
  readonly schema: Schema;
  readonly run: (input: Static<Schema>) => Promise<ToolResult>;
}

/** A `MemoryTool` with its descriptor and a handler that validates untyped input. */
interface DefinedTool {
  readonly descriptor: ToolDescriptor;
  readonly execute: (input: JsonValue) => Promise<ToolResult>;
}

const defineTool = <Schema extends TSchema>(
  tool: MemoryTool<Schema>
): DefinedTool => ({
  descriptor: {
    defaultAction: "allow",
    description: tool.description,
    inputSchema: toJsonSchema(tool.schema),
    name: canonicalToolName({ kind: "builtin" }, tool.name),
    source: "builtin",
  },
  execute: async (input) => {
    if (!Value.Check(tool.schema, input)) {
      const issues = Value.Errors(tool.schema, input).map(
        (error) =>
          `${error.instancePath === "" ? "/" : error.instancePath} ${error.message}`
      );

      return errorResult(
        `Invalid input for ${tool.name}: ${issues.join("; ")}`
      );
    }

    return await tool.run(input);
  },
});

const searchTool = (store: MemoryStore): DefinedTool =>
  defineTool({
    description:
      "Searches Memory files and past Conversations (user and assistant messages) by keywords. Returns the best matches first. Use memory_read to read a whole Memory file.",
    name: "memory_search",
    run: async (input) => {
      const hits = await store.search(input.query, {
        limit: input.limit ?? TOOL_SEARCH_LIMIT,
        scope: input.scope ?? "all",
      });

      return textResult(
        hits.length === 0
          ? `No matches for "${input.query}".`
          : hits.map(formatHit).join("\n")
      );
    },
    schema: SearchInput,
  });

const readTool = (store: MemoryStore): DefinedTool =>
  defineTool({
    description:
      'Reads one Memory file: name "MEMORY" for MEMORY.md, or a topic slug such as "travel" for travel.md. Without a name, lists the Memory files and the MEMORY.md budget.',
    name: "memory_read",
    run: async (input) => {
      if (input.name === undefined) {
        const { budget, files } = await store.list();

        return textResult(
          [
            `MEMORY.md budget: ${budget.usedChars} of ${budget.maxChars} characters.`,
            ...files.map(fileSizeLine),
          ].join("\n")
        );
      }

      const content = await store.read(input.name);

      if (content === undefined) {
        return errorResult(`${memoryFileName(input.name)} does not exist.`);
      }

      return textResult(
        content === "" ? `${memoryFileName(input.name)} is empty.` : content
      );
    },
    schema: ReadInput,
  });

const writeTool = (store: MemoryStore): DefinedTool =>
  defineTool({
    description:
      'Saves Markdown to a Memory file: name "MEMORY" for MEMORY.md (short, always in your system prompt, with a character cap) or a topic slug such as "travel" for details. Mode "replace" (default) overwrites the file, "append" adds a new line at the end. A MEMORY.md write over the cap fails and changes nothing.',
    name: "memory_write",
    run: async (input) => {
      const file = await store.write(
        input.name,
        input.content,
        input.mode ?? "replace"
      );

      if (file.name !== MEMORY_NAME) {
        return textResult(
          `Saved ${memoryFileName(file.name)} (${file.chars} characters).`
        );
      }

      const { budget } = await store.list();

      return textResult(
        `Saved MEMORY.md (${file.chars} of ${budget.maxChars} characters).`
      );
    },
    schema: WriteInput,
  });

const deleteTool = (store: MemoryStore): DefinedTool =>
  defineTool({
    description:
      'Deletes a topic file, or empties MEMORY.md for name "MEMORY".',
    name: "memory_delete",
    run: async (input) => {
      const deleted = await store.delete(input.name);
      const fileName = memoryFileName(input.name);

      if (!deleted) {
        return textResult(`${fileName} does not exist.`);
      }

      return textResult(
        input.name === MEMORY_NAME
          ? "Emptied MEMORY.md."
          : `Deleted ${fileName}.`
      );
    },
    schema: DeleteInput,
  });

const noHealth = (): readonly ExtensionStatus[] => [];

const closeNothing = async (): Promise<void> => {
  await Promise.resolve();
};

/**
 * Creates the `ToolProvider` of the built-in Memory Tools: `memory_search`, `memory_read`, `memory_write`, and
 * `memory_delete`. Each Tool has the default action `allow` (ADR 0009). The provider has no extensions, so `health`
 * is empty and `close` does nothing.
 */
export const createMemoryTools = (store: MemoryStore): ToolProvider => {
  const defined = new Map(
    [
      searchTool(store),
      readTool(store),
      writeTool(store),
      deleteTool(store),
    ].map((tool) => [tool.descriptor.name, tool])
  );

  const descriptors = [...defined.values()].map((tool) => tool.descriptor);

  const execute = async (
    name: string,
    input: JsonValue,
    ctx: ToolContext
  ): Promise<ToolResult> => {
    const tool = defined.get(name);

    if (tool === undefined) {
      return errorResult(`Unknown Tool: ${name}`);
    }

    if (ctx.signal.aborted) {
      return errorResult(`${name} was aborted`);
    }

    try {
      return await tool.execute(input);
    } catch (error) {
      return errorResult(errorMessage(error));
    }
  };

  return {
    close: closeNothing,
    execute,
    health: noHealth,
    tools: () => descriptors,
  };
};
