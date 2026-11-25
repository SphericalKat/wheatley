import type { Frontend } from "@wheatley-ai/sdk";

import type {
  AgentExtensions,
  ExtensionCatalog,
} from "../contracts/extension-catalog.js";
import { createBuiltinToolProvider } from "../tools/builtin-tools.js";

/**
 * The extension catalog of a Deployment without the Plugins, MCP, and Skills modules: each Agent gets its own built-in
 * Tools and nothing else. The Wave 2 catalog replaces it and adds the other providers after the built-in Tools.
 */
export const builtinOnlyCatalog: ExtensionCatalog = {
  createAgentExtensions: async (): Promise<AgentExtensions> => {
    await Promise.resolve();
    const builtin = createBuiltinToolProvider();

    return {
      close: builtin.close,
      executeTool: builtin.execute,
      frontends: () => new Map<string, Frontend>(),
      health: () => ({ mcpServers: [], plugins: [], skillWarnings: [] }),
      skillCatalogPrompt: () => "",
      skills: () => [],
      tools: builtin.tools,
    };
  },
};
