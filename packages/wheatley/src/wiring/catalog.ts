import type { Frontend } from "@wheatley/sdk";

import type {
  AgentExtensions,
  ExtensionCatalog,
  PluginProvider,
  ProviderInput,
  SkillProvider,
  ToolProvider,
} from "../contracts/extension-catalog.js";
import { errorMessage } from "../core/error-message.js";
import { createDiscordFrontend } from "../frontends/discord/module.js";
import { createSlackFrontend } from "../frontends/slack/slack-frontend.js";
import { createTelegramFrontend } from "../frontends/telegram/frontend.js";
import { createMcpToolProvider } from "../mcp/mcp-tool-provider.js";
import type { McpTimeouts } from "../mcp/server-connection.js";
import { createPluginProvider } from "../plugins/provider.js";
import type { PluginProviderOptions } from "../plugins/provider.js";
import { createSkillProvider } from "../skills/skills.js";
import { createBuiltinToolProvider } from "../tools/builtin-tools.js";

/** Options of `createExtensionCatalog`. */
export interface ExtensionCatalogOptions {
  /**
   * The built-in Frontends. The default is Telegram, Slack, and Discord. Tests pass Frontends with fake platform
   * clients. A Plugin Frontend with the same `type` replaces a built-in one.
   */
  readonly frontends?: readonly Frontend[];
  readonly plugins?: PluginProviderOptions;
  readonly mcpTimeouts?: McpTimeouts;
}

/** The built-in Telegram, Slack, and Discord Frontends with their real platform clients. */
export const builtinFrontends = (): readonly Frontend[] => [
  createTelegramFrontend(),
  createSlackFrontend(),
  createDiscordFrontend(),
];

const toolErrorResult = (text: string) => ({
  content: [{ text, type: "text" as const }],
  isError: true,
});

/** Closes a provider and logs a failure, so one provider cannot stop the others from closing. */
const closeQuietly = async (
  provider: ToolProvider,
  input: ProviderInput
): Promise<void> => {
  try {
    await provider.close();
  } catch (error) {
    input.log.warn("An extension provider failed to close", {
      error: errorMessage(error),
    });
  }
};

/** Merges the providers of one Agent. Tool names are canonical and namespaced, so the first owner wins. */
const mergeProviders = (
  input: ProviderInput,
  builtin: ToolProvider,
  plugins: PluginProvider,
  mcp: ToolProvider,
  skills: SkillProvider,
  frontends: readonly Frontend[]
): AgentExtensions => {
  const providers: readonly ToolProvider[] = [builtin, plugins, mcp, skills];

  const owner = (name: string): ToolProvider | undefined =>
    providers.find((provider) =>
      provider.tools().some((tool) => tool.name === name)
    );

  return {
    close: async () => {
      await Promise.all(
        providers.map(async (provider) => {
          await closeQuietly(provider, input);
        })
      );
    },
    executeTool: async (name, toolInput, ctx) =>
      (await owner(name)?.execute(name, toolInput, ctx)) ??
      toolErrorResult(`Unknown Tool: ${name}`),
    frontends: () =>
      new Map(
        [...frontends, ...plugins.frontends()].map((frontend) => [
          frontend.type,
          frontend,
        ])
      ),
    health: () => ({
      mcpServers: mcp.health(),
      plugins: plugins.health(),
      skillWarnings: skills.warnings(),
    }),
    skillCatalogPrompt: skills.catalogPrompt,
    skills: skills.skills,
    tools: () => providers.flatMap((provider) => provider.tools()),
  };
};

/**
 * The `ExtensionCatalog` of the Deployment (ADR 0006). Each Agent gets its own built-in Tools, Plugins, MCP Server
 * connections, and Skills, in that Tool order, plus the built-in Frontends and the Frontends of its Plugins.
 *
 * A broken Plugin, MCP Server, or Skill does not reject: it reports in `health`. If a later provider fails to load,
 * the providers that loaded are closed before the promise rejects.
 */
export const createExtensionCatalog = (
  options: ExtensionCatalogOptions = {}
): ExtensionCatalog => ({
  createAgentExtensions: async (input) => {
    const frontends = options.frontends ?? builtinFrontends();
    const loaded: ToolProvider[] = [];

    try {
      const builtin = createBuiltinToolProvider();

      loaded.push(builtin);

      const plugins = await createPluginProvider(input, options.plugins);

      loaded.push(plugins);

      const mcp = await createMcpToolProvider(input, options.mcpTimeouts);

      loaded.push(mcp);

      const skills = await createSkillProvider(input);

      loaded.push(skills);

      return mergeProviders(input, builtin, plugins, mcp, skills, frontends);
    } catch (error) {
      await Promise.all(
        loaded.map(async (provider) => {
          await closeQuietly(provider, input);
        })
      );
      throw error;
    }
  },
});
