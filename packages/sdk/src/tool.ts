import type { JsonValue } from "./json.js";
import type { Logger } from "./logger.js";
import type { SchemaInput } from "./schema.js";

/**
 * One block of Tool output. `text` and `image` have the shape of the MCP `CallToolResult` blocks of the same type, so
 * they pass through. The MCP provider converts every other MCP block (`audio`, `resource_link`, embedded `resource`)
 * and `structuredContent` to `text` blocks.
 */
export type ToolContent =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "image";
      readonly mimeType: string;
      readonly data: string;
    };

/**
 * The result of one Tool call.
 *
 * Set `isError` to report a failure to the model. The model reads the content and can adapt its plan.
 */
export interface ToolResult {
  readonly content: readonly ToolContent[];
  readonly isError?: boolean;
}

/** Context of one Tool call. */
export interface ToolContext {
  /** Aborts when the call times out, the Run stops, or the Agent stops. */
  readonly signal: AbortSignal;
  readonly agentName: string;
  readonly conversationId: string;
  readonly runId: string;
  /**
   * The Chat that started the Run, or `null` for a Run without a Chat (Trigger and maintenance Runs). Tools that act
   * on "this Chat", such as `schedule_trigger`, use it as the target.
   */
  readonly chat: { readonly bindingId: string; readonly chatId: string } | null;
  /** Stable across retries of the same call. Use it as an idempotency key for external side effects. */
  readonly toolCallId: string;
  /** The working directory of the Agent. */
  readonly workspaceDir: string;
  readonly log: Logger;
}

/**
 * One callable action for an Agent (ADR 0006).
 *
 * Built-in Tools use bare names. Wheatley exposes Plugin Tools as `<plugin>:<name>`, so `name` must not contain `:`.
 * Every call passes the Permission Policy, input validation against `inputSchema`, a timeout, and a concurrency gate
 * before `execute` runs.
 */
export interface Tool<Input = JsonValue> {
  /** Matches `^[a-z][a-z0-9_]*$`. */
  readonly name: string;
  readonly description: string;
  readonly inputSchema: SchemaInput<Input>;
  /**
   * Runs the call with validated input.
   *
   * Return `{ isError: true }` for expected failures. Wheatley catches a throw and returns it to the model as an error
   * result. Stop work when `ctx.signal` aborts.
   */
  readonly execute: (input: Input, ctx: ToolContext) => Promise<ToolResult>;
}

/** Returns `tool` unchanged, typed so that a Standard JSON Schema output type flows into `execute`. */
export const defineTool = <Input = JsonValue>(tool: Tool<Input>): Tool<Input> =>
  tool;
