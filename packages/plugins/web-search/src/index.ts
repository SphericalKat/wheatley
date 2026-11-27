import { definePlugin } from "@wheatley-ai/sdk";
import { Type } from "typebox";
import type { Static } from "typebox";

import { createFetchTool } from "./fetch.js";
import { toJsonSchema } from "./schema.js";
import { createSearchTool, SelectionSchema } from "./search.js";

/**
 * The `config` block of the Plugin in `config.yaml`. `provider` defaults to `random`, which picks one provider and
 * fails over when it is rate limited.
 */
const ConfigSchema = Type.Object(
  { provider: Type.Optional(SelectionSchema) },
  { additionalProperties: false }
);

export type WebSearchConfig = Static<typeof ConfigSchema>;

/**
 * The bundled `web-search` Plugin (ADR 0015). It contributes `web-search:search`, which queries Exa, Firecrawl,
 * Parallel, Tavily, or TinyFish, and `web-search:fetch`, which downloads one web page.
 *
 * Search works without API keys. If the secret `EXA_API_KEY`, `FIRECRAWL_API_KEY`, `PARALLEL_API_KEY`,
 * `TAVILY_API_KEY`, or `TINYFISH_API_KEY` exists, the matching provider uses it.
 */
export default definePlugin<WebSearchConfig>({
  apiVersion: 1,
  configSchema: toJsonSchema(ConfigSchema),
  name: "web-search",
  setup: ({ config, secrets }) => ({
    tools: [
      createSearchTool(config.provider ?? "random", secrets),
      createFetchTool(),
    ],
  }),
  version: "1.0.0",
});
