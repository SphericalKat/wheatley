import type { ToolResult } from "@wheatley/sdk";

import type {
  AgentExtensions,
  ToolProvider,
} from "../contracts/extension-catalog.js";

/** A Tool result that reports `text` as an error to the model. The Run continues. */
export const toolErrorResult = (text: string): ToolResult => ({
  content: [{ text, type: "text" }],
  isError: true,
});

/** The first provider that offers the Tool `name`, or `undefined` if none does. */
export const findToolOwner = (
  providers: readonly ToolProvider[],
  name: string
): ToolProvider | undefined =>
  providers.find((provider) =>
    provider.tools().some((tool) => tool.name === name)
  );

/**
 * Adds the Tools of `providers` after the Tools of `extensions`. A call to a Tool of `providers` goes to its provider,
 * and every other call goes to `extensions`.
 *
 * Errors: throws if a provider offers a Tool with the name of another Tool, because the model could not tell the two
 * apart.
 */
export const withExtraTools = (
  extensions: AgentExtensions,
  providers: readonly ToolProvider[]
): AgentExtensions => {
  if (providers.length === 0) {
    return extensions;
  }

  const names = new Set(extensions.tools().map((tool) => tool.name));

  for (const provider of providers) {
    for (const tool of provider.tools()) {
      if (names.has(tool.name)) {
        throw new Error(`Two providers offer the Tool ${tool.name}`);
      }

      names.add(tool.name);
    }
  }

  return {
    ...extensions,
    executeTool: async (name, input, ctx) => {
      const provider = findToolOwner(providers, name);

      return provider === undefined
        ? await extensions.executeTool(name, input, ctx)
        : await provider.execute(name, input, ctx);
    },
    tools: () => [
      ...extensions.tools(),
      ...providers.flatMap((provider) => provider.tools()),
    ],
  };
};
