import type { Frontend } from "@wheatley/sdk";

import type {
  AgentExtensions,
  ExtensionCatalog,
  PluginProvider,
  ProviderInput,
  SkillProvider,
  ToolProvider,
} from "./extension-catalog.js";
import { simulateIo } from "./fake-io.js";
import { toolErrorResult } from "./tool-provider.fake.js";

/** The providers of one Agent, as the fake catalog's factory returns them. */
export interface FakeAgentProviders {
  readonly builtin?: ToolProvider;
  /** Plugin providers. A provider that also implements `PluginProvider.frontends` contributes Frontends. */
  readonly plugins?: readonly (ToolProvider | PluginProvider)[];
  readonly mcp?: ToolProvider;
  readonly skills?: SkillProvider;
  /** The built-in Frontends. */
  readonly frontends?: readonly Frontend[];
}

const pluginFrontends = (
  provider: ToolProvider | PluginProvider
): readonly Frontend[] => ("frontends" in provider ? provider.frontends() : []);

/**
 * An `ExtensionCatalog` that calls `createProviders` once for each Agent, so Agents share no provider instances
 * (ADR 0006).
 *
 * `createAgentExtensions` throws if two providers offer the same canonical Tool name. The real providers namespace
 * their Tools, so a duplicate name in the fake is a defect in the test setup.
 */
export class InMemoryExtensionCatalog implements ExtensionCatalog {
  readonly #createProviders: (input: ProviderInput) => FakeAgentProviders;
  readonly #agents: string[] = [];

  constructor(createProviders: (input: ProviderInput) => FakeAgentProviders) {
    this.#createProviders = createProviders;
  }

  /** The Agent names that `createAgentExtensions` received, in call order. */
  get agents(): readonly string[] {
    return this.#agents;
  }

  readonly createAgentExtensions = async (
    input: ProviderInput
  ): Promise<AgentExtensions> => {
    await simulateIo();
    this.#agents.push(input.agentName);

    const {
      builtin,
      plugins = [],
      mcp,
      skills,
      frontends = [],
    } = this.#createProviders(input);

    const providers = [builtin, ...plugins, mcp, skills].filter(
      (provider): provider is ToolProvider => provider !== undefined
    );

    const names = providers.flatMap((provider) =>
      provider.tools().map((tool) => tool.name)
    );

    const duplicate = names.find(
      (name, index) => names.indexOf(name) !== index
    );

    if (duplicate !== undefined) {
      throw new Error(`Two providers offer the Tool ${duplicate}`);
    }

    const owner = (name: string): ToolProvider | undefined =>
      providers.find((provider) =>
        provider.tools().some((tool) => tool.name === name)
      );

    return {
      close: async () => {
        await Promise.allSettled(
          providers.map(async (provider) => {
            await provider.close();
          })
        );
      },
      executeTool: async (name, toolInput, ctx) =>
        (await owner(name)?.execute(name, toolInput, ctx)) ??
        toolErrorResult(`Unknown Tool: ${name}`),
      frontends: () =>
        new Map(
          [...frontends, ...plugins.flatMap(pluginFrontends)].map(
            (frontend) => [frontend.type, frontend]
          )
        ),
      health: () => ({
        mcpServers: mcp?.health() ?? [],
        plugins: plugins.flatMap((provider) => provider.health()),
        skillWarnings: skills?.warnings() ?? [],
      }),
      skillCatalogPrompt: () => skills?.catalogPrompt() ?? "",
      skills: () => skills?.skills() ?? [],
      tools: () => providers.flatMap((provider) => provider.tools()),
    };
  };
}
