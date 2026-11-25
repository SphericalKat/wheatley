import type { PermissionAction } from "@wheatley/protocol";
import type { JsonSchema, Tool, ToolResult } from "@wheatley/sdk";

import type {
  ToolDescriptor,
  ToolProvider,
} from "../contracts/extension-catalog.js";
import { canonicalToolName } from "../contracts/tool-names.js";
import { errorMessage } from "../core/error-message.js";
import { readFileTool } from "./read-file.js";
import { shellTool } from "./shell.js";
import { writeFileTool } from "./write-file.js";

/**
 * The built-in Tools and the action of each when no Permission Policy rule matches. Reading is safe. Writing files and
 * running commands change the host, so they ask first (ADR 0011).
 */
export const BUILTIN_TOOLS: readonly {
  readonly tool: Tool;
  readonly defaultAction: PermissionAction;
}[] = [
  { defaultAction: "allow", tool: readFileTool },
  { defaultAction: "ask", tool: writeFileTool },
  { defaultAction: "ask", tool: shellTool },
];

/** Returns the default action of a built-in Tool, or `undefined` for any other Tool. */
export const builtinDefaultAction = (
  toolName: string
): PermissionAction | undefined =>
  BUILTIN_TOOLS.find(({ tool }) => tool.name === toolName)?.defaultAction;

const errorResult = (message: string): ToolResult => ({
  content: [{ text: message, type: "text" }],
  isError: true,
});

const plainSchema = (tool: Tool): JsonSchema =>
  "~standard" in tool.inputSchema ? { type: "object" } : tool.inputSchema;

/**
 * Creates the `ToolProvider` of the built-in Tools `read_file`, `write_file`, and `shell`. Each Agent gets its own
 * instance. The provider holds no resources, so `close` only blocks later calls.
 */
export const createBuiltinToolProvider = (): ToolProvider => {
  const tools = new Map(
    BUILTIN_TOOLS.map((entry) => [
      canonicalToolName({ kind: "builtin" }, entry.tool.name),
      entry,
    ])
  );

  let closed = false;

  return {
    close: async () => {
      closed = true;
      await Promise.resolve();
    },
    execute: async (name, input, ctx) => {
      const entry = tools.get(name);

      if (entry === undefined || closed) {
        return errorResult(`Unknown Tool: ${name}`);
      }

      if (ctx.signal.aborted) {
        return errorResult(`${name} was stopped before it started`);
      }

      try {
        return await entry.tool.execute(input, ctx);
      } catch (error) {
        return errorResult(errorMessage(error));
      }
    },
    health: () => [],
    tools: (): readonly ToolDescriptor[] =>
      [...tools.entries()].map(([name, entry]) => ({
        defaultAction: entry.defaultAction,
        description: entry.tool.description,
        inputSchema: plainSchema(entry.tool),
        name,
        source: "builtin",
      })),
  };
};
