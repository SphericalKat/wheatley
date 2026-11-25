import type { Frontend } from "@wheatley/sdk";

import type {
  AgentExtensions,
  ExtensionCatalog,
  ProviderInput,
  ToolProvider,
} from "./extension-catalog.js";
import { simulateIo } from "./fake-io.js";
import { toolErrorResult } from "./tool-provider.fake.js";

/** An `ExtensionCatalog` that gives every Agent the same providers and Frontends. */
export class InMemoryExtensionCatalog implements ExtensionCatalog {
  readonly #providers: readonly ToolProvider[];
  readonly #frontends: readonly Frontend[];
  readonly #agents: string[] = [];

  constructor(
    providers: readonly ToolProvider[],
    frontends: readonly Frontend[] = []
  ) {
    this.#providers = providers;
    this.#frontends = frontends;
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
    const providers = this.#providers;

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
        new Map(this.#frontends.map((frontend) => [frontend.type, frontend])),
      health: () => ({
        mcpServers: [],
        plugins: providers.flatMap((provider) => provider.health()),
        skillWarnings: [],
      }),
      skillCatalogPrompt: () => "",
      skills: () => [],
      tools: () => providers.flatMap((provider) => provider.tools()),
    };
  };
}
