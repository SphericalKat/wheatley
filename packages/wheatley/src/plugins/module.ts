import type { AgentConfig } from "@wheatley-ai/protocol";
import type { SecretReader } from "@wheatley-ai/sdk";

import type { PluginProvider } from "../contracts/extension-catalog.js";
import type { AgentModule, RpcHandlerMap } from "../contracts/module.js";
import type { Migration } from "../db/migrations.js";
import { createPluginProvider } from "./provider.js";
import type { PluginProviderOptions } from "./provider.js";

/** What the Agent gives the Plugins module besides `AgentModuleContext`. */
export interface PluginsModuleDeps {
  /** The Deployment home: npm Plugins resolve from its `extensions/` folder, and relative local paths against it. */
  readonly homeDir: string;
  /** The Agent config. The module reads its `plugins` entries. */
  readonly config: AgentConfig;
  /** Reads the secrets that Plugins request through `PluginSetupContext.secrets`. */
  readonly secrets: SecretReader;
  /** Aborts when the Agent stops while its Plugins load. */
  readonly signal: AbortSignal;
  /** The `setup` and `dispose` time limits. Absent fields use the defaults of `createPluginProvider`. */
  readonly options?: PluginProviderOptions;
}

/** The Plugins module keeps no state in `agent.sqlite`. */
export const pluginMigrations: readonly Migration[] = [];

/**
 * The Plugins module handles no JSON-RPC method of its own. Plugin status reaches `extensions.list` and Agent health
 * through `PluginProvider.health`, which the `ExtensionCatalog` merges with the other providers.
 */
export const pluginRpcHandlers: RpcHandlerMap = {};

/**
 * The Plugins module of one Agent (ADR 0006). Its API is the `PluginProvider` of `createPluginProvider`.
 *
 * `create` loads the Plugins of `deps.config`. It never rejects because of a broken Plugin: that Plugin reports
 * `failed` in `api.health()`, and the Agent starts without it. `stop` disposes every loaded Plugin.
 */
export const pluginsModule: AgentModule<PluginsModuleDeps, PluginProvider> = {
  create: async (ctx, deps) => {
    const provider = await createPluginProvider(
      {
        agentDir: ctx.agentDir,
        agentName: ctx.agentName,
        config: deps.config,
        homeDir: deps.homeDir,
        log: ctx.log,
        secrets: deps.secrets,
        signal: deps.signal,
      },
      deps.options
    );

    return { api: provider, rpc: pluginRpcHandlers, stop: provider.close };
  },
  migrations: pluginMigrations,
  name: "plugins",
  scope: "agent",
};
