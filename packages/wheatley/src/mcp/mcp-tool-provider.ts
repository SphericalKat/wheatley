import type { ExtensionStatus, JsonValue } from "@wheatley/protocol";
import type { ToolContext, ToolResult } from "@wheatley/sdk";

import type {
  ProviderInput,
  ToolDescriptor,
  ToolProvider,
} from "../contracts/extension-catalog.js";
import { errorResult } from "./content.js";
import { McpServerConnection } from "./server-connection.js";
import type { McpTimeouts } from "./server-connection.js";

const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_CALL_TIMEOUT_MS = 3_600_000;

/** The default MCP time limits. */
export const DEFAULT_MCP_TIMEOUTS: McpTimeouts = {
  callMs: DEFAULT_CALL_TIMEOUT_MS,
  connectMs: DEFAULT_CONNECT_TIMEOUT_MS,
};

/** What the MCP provider reads from the Agent. */
export type McpProviderInput = Pick<
  ProviderInput,
  "agentDir" | "agentName" | "config" | "log" | "secrets"
>;

/**
 * The `ToolProvider` of the MCP Servers of one Agent (ADR 0006).
 *
 * It offers each Tool as `mcp:<server>:<tool>` with the default action `ask`, so the Permission Policy governs every
 * call. A server that fails to connect, or that disconnects later, contributes no Tools and reports `failed` in
 * `health`. The other servers keep working.
 */
export class McpToolProvider implements ToolProvider {
  readonly #connections: readonly McpServerConnection[];
  readonly #stop = new AbortController();
  #connecting: Promise<void> | undefined;
  #closing: Promise<void> | undefined;

  constructor(
    input: McpProviderInput,
    timeouts: McpTimeouts = DEFAULT_MCP_TIMEOUTS
  ) {
    this.#connections = Object.entries(input.config.mcpServers ?? {}).map(
      ([name, config]) =>
        new McpServerConnection({
          agentDir: input.agentDir,
          config,
          log: input.log,
          name,
          secrets: input.secrets,
          timeouts,
        })
    );
  }

  /**
   * Connects every enabled MCP Server in parallel.
   *
   * Resolves after each server is `ready` or `failed`. Never rejects. Later calls return the first call's promise.
   * `signal`, or a `close` call, aborts the connects that are still open, and those servers fail.
   */
  readonly connect = async (signal?: AbortSignal): Promise<void> => {
    this.#connecting ??= this.#connectAll(signal);
    await this.#connecting;
  };

  readonly tools = (): readonly ToolDescriptor[] =>
    this.#connections.flatMap((connection) => connection.tools());

  readonly execute = async (
    name: string,
    input: JsonValue,
    ctx: ToolContext
  ): Promise<ToolResult> => {
    const connection = this.#connections.find((candidate) =>
      candidate.owns(name)
    );

    if (connection === undefined) {
      return errorResult(`Unknown Tool: ${name}`);
    }

    return await connection.execute(name, input, ctx.signal);
  };

  readonly health = (): readonly ExtensionStatus[] =>
    this.#connections.map((connection) => connection.status());

  /**
   * Aborts open connects, waits for them to settle, then closes every connection. Stdio server processes end.
   *
   * Every server reports `stopped`, except a disabled one. Never rejects. Later calls return the first call's promise.
   */
  readonly close = async (): Promise<void> => {
    this.#closing ??= this.#closeAll();
    await this.#closing;
  };

  readonly #connectAll = async (
    signal: AbortSignal | undefined
  ): Promise<void> => {
    const combined =
      signal === undefined
        ? this.#stop.signal
        : AbortSignal.any([signal, this.#stop.signal]);

    await Promise.all(
      this.#connections.map(async (connection) => {
        await connection.connect(combined);
      })
    );
  };

  readonly #closeAll = async (): Promise<void> => {
    this.#stop.abort(new Error("MCP provider closed"));
    await this.#connecting;
    await Promise.all(
      this.#connections.map(async (connection) => {
        await connection.close();
      })
    );
  };
}

/**
 * Creates the MCP `ToolProvider` of one Agent for the `ExtensionCatalog` and connects its servers.
 *
 * Resolves after every enabled server is `ready` or `failed`. Never rejects because of one MCP Server.
 * `input.signal` aborts the connects that are still open.
 */
export const createMcpToolProvider = async (
  input: ProviderInput,
  timeouts: McpTimeouts = DEFAULT_MCP_TIMEOUTS
): Promise<ToolProvider> => {
  const provider = new McpToolProvider(input, timeouts);

  await provider.connect(input.signal);

  return provider;
};
