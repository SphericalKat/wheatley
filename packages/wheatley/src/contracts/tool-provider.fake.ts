import type {
  ExtensionStatus,
  JsonValue,
  PermissionAction,
  ToolSource,
} from "@wheatley/protocol";
import type { JsonSchema, Tool, ToolContext, ToolResult } from "@wheatley/sdk";

import type { ToolDescriptor, ToolProvider } from "./extension-catalog.js";
import { simulateIo } from "./fake-io.js";

/** A Tool result that reports `text` as an error to the model. */
export const toolErrorResult = (text: string): ToolResult => ({
  content: [{ text, type: "text" }],
  isError: true,
});

/** One Tool of a fake provider: an SDK Tool with plain JSON Schema input and its canonical name. */
export interface FakeTool {
  readonly name: string;
  readonly tool: Tool;
  readonly defaultAction?: PermissionAction;
}

const plainSchema = (tool: Tool): JsonSchema =>
  "~standard" in tool.inputSchema ? { type: "object" } : tool.inputSchema;

/**
 * A `ToolProvider` over in-memory SDK Tools. It does not validate input against the schema; it does turn unknown
 * Tools, throws, and aborts into error results, as the real providers do.
 */
export class FakeToolProvider implements ToolProvider {
  readonly #source: ToolSource;
  readonly #tools: ReadonlyMap<string, FakeTool>;
  readonly #health: readonly ExtensionStatus[];
  #closed = false;

  constructor(
    source: ToolSource,
    tools: readonly FakeTool[],
    health: readonly ExtensionStatus[] = []
  ) {
    this.#source = source;
    this.#tools = new Map(tools.map((entry) => [entry.name, entry]));
    this.#health = health;
  }

  /** True after `close`. */
  get closed(): boolean {
    return this.#closed;
  }

  readonly tools = (): readonly ToolDescriptor[] =>
    [...this.#tools.values()].map((entry) => ({
      defaultAction:
        entry.defaultAction ?? (this.#source === "builtin" ? "allow" : "ask"),
      description: entry.tool.description,
      inputSchema: plainSchema(entry.tool),
      name: entry.name,
      source: this.#source,
    }));

  readonly execute = async (
    name: string,
    input: JsonValue,
    ctx: ToolContext
  ): Promise<ToolResult> => {
    const entry = this.#tools.get(name);

    if (entry === undefined) {
      return toolErrorResult(`Unknown Tool: ${name}`);
    }

    if (ctx.signal.aborted) {
      return toolErrorResult(`${name} was aborted`);
    }

    try {
      return await entry.tool.execute(input, ctx);
    } catch (error) {
      return toolErrorResult(
        error instanceof Error ? error.message : String(error)
      );
    }
  };

  readonly health = (): readonly ExtensionStatus[] => this.#health;

  readonly close = async (): Promise<void> => {
    await simulateIo();
    this.#closed = true;
  };
}
