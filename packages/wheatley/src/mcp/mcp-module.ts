import type { AgentConfig } from "@wheatley-ai/protocol";
import type { SecretReader } from "@wheatley-ai/sdk";

import type { ToolProvider } from "../contracts/extension-catalog.js";
import type { AgentModule, RpcHandlerMap } from "../contracts/module.js";
import type { Migration } from "../db/migrations.js";
import { McpToolProvider } from "./mcp-tool-provider.js";
import type { McpTimeouts } from "./server-connection.js";

/** The dependencies of the MCP module of one Agent. */
export interface McpModuleDeps {
  /** The Agent's config. The module reads `mcpServers`. */
  readonly config: AgentConfig;
  /** Resolves the `{ secret }` references in `env` and `headers`. */
  readonly secrets: SecretReader;
  /** The MCP time limits. The default is `DEFAULT_MCP_TIMEOUTS`. */
  readonly timeouts?: McpTimeouts;
}

/** The MCP module stores nothing in `agent.sqlite`. */
export const mcpMigrations: readonly Migration[] = [];

/** The MCP module handles no JSON-RPC method. `extensions.list` reads its status through `ToolProvider.health`. */
export const mcpRpcHandlers: RpcHandlerMap = {};

/**
 * The MCP Server client manager of one Agent (ADR 0006). Its API is the MCP `ToolProvider`.
 *
 * `start` connects every enabled server and resolves after each one is `ready` or `failed`. It never rejects, so one
 * broken server never stops the Agent. `stop` aborts open connects, closes every client, and ends stdio processes.
 */
export const mcpModule: AgentModule<McpModuleDeps, ToolProvider> = {
  create: (ctx, deps) => {
    const provider = new McpToolProvider(
      {
        agentDir: ctx.agentDir,
        agentName: ctx.agentName,
        config: deps.config,
        log: ctx.log,
        secrets: deps.secrets,
      },
      deps.timeouts
    );

    return {
      api: provider,
      rpc: mcpRpcHandlers,
      start: async () => {
        await provider.connect();
      },
      stop: async () => {
        await provider.close();
      },
    };
  },
  migrations: mcpMigrations,
  name: "mcp",
  scope: "agent",
};
