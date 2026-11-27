import { defineTool } from "@wheatley-ai/sdk";
import type { SecretReader, Tool, ToolResult } from "@wheatley-ai/sdk";
import { Type } from "typebox";
import type { Static } from "typebox";

import { HttpStatusError } from "./http.js";
import { PROVIDER_IDS, PROVIDERS } from "./providers.js";
import type { ProviderId, SearchHit, SearchProvider } from "./providers.js";
import { toJsonSchema } from "./schema.js";

/** How the Plugin picks a provider when a call names none. */
export type Selection = "random" | ProviderId;

/** The cooldown after an HTTP 429 response without a usable `Retry-After` header. */
const DEFAULT_COOLDOWN_MS = 60_000;

const MS_PER_SECOND = 1000;

const HTTP_TOO_MANY_REQUESTS = 429;

const HTTP_UNAUTHORIZED = 401;

export const NO_RESULTS =
  "No search results found. Please try a different query.";

const SearchInputSchema = Type.Object(
  {
    provider: Type.Optional(
      Type.Enum(PROVIDER_IDS, {
        description:
          "A specific search provider. Omit it to use the configured provider.",
      })
    ),
    query: Type.String({ description: "The search query", minLength: 1 }),
  },
  { additionalProperties: false }
);

type SearchInput = Static<typeof SearchInputSchema>;

/** The provider schema of the Plugin config. */
export const SelectionSchema = Type.Enum(["random", ...PROVIDER_IDS]);

/** A failed search, with the provider that failed. */
class SearchError extends Error {
  readonly provider: SearchProvider;

  constructor(provider: SearchProvider, cause: unknown) {
    super(`${provider.name} search failed`, { cause });
    this.name = "SearchError";
    this.provider = provider;
  }
}

/** Converts a `Retry-After` header (seconds or an HTTP date) to a cooldown length. */
const cooldownMs = (retryAfter: string | undefined, now: number): number => {
  if (retryAfter === undefined || retryAfter.trim() === "") {
    return DEFAULT_COOLDOWN_MS;
  }

  const seconds = Number(retryAfter);

  if (Number.isFinite(seconds)) {
    return seconds >= 0 ? seconds * MS_PER_SECOND : DEFAULT_COOLDOWN_MS;
  }

  const date = Date.parse(retryAfter);

  return Number.isFinite(date) ? Math.max(0, date - now) : DEFAULT_COOLDOWN_MS;
};

const isRateLimit = (error: unknown): error is HttpStatusError =>
  error instanceof HttpStatusError && error.status === HTTP_TOO_MANY_REQUESTS;

interface Cooldown {
  readonly until: number;
  readonly error: SearchError;
}

const runProvider = async (
  provider: SearchProvider,
  query: string,
  secrets: SecretReader,
  signal: AbortSignal
): Promise<readonly SearchHit[]> => {
  try {
    return await provider.search({
      apiKey: secrets.get(provider.secret),
      query,
      signal,
    });
  } catch (error) {
    throw new SearchError(provider, error);
  }
};

/**
 * Creates the search state of one Agent.
 *
 * With `random`, the searcher keeps one randomly chosen provider for every call. If that provider answers HTTP 429, it
 * goes on cooldown for its `Retry-After` time (60 seconds by default), and the call fails over to another random
 * provider that is not on cooldown. Other errors do not fail over. A call that names a provider, or a fixed
 * `selection`, uses that provider without cooldowns.
 *
 * Errors: `search` rejects with `SearchError` when the provider fails, or when every provider is on cooldown.
 */
const createSearcher = (
  selection: Selection,
  secrets: SecretReader
): ((
  query: string,
  provider: ProviderId | undefined,
  signal: AbortSignal
) => Promise<readonly SearchHit[]>) => {
  const cooldowns = new Map<ProviderId, Cooldown>();
  let current: ProviderId | undefined;

  const pickRandom = (
    attempted: ReadonlySet<ProviderId>
  ): ProviderId | undefined => {
    const now = Date.now();

    for (const [id, cooldown] of cooldowns) {
      if (cooldown.until <= now) {
        cooldowns.delete(id);
      }
    }

    const usable = (id: ProviderId): boolean =>
      !cooldowns.has(id) && !attempted.has(id);

    if (current !== undefined && usable(current)) {
      return current;
    }

    const available = PROVIDER_IDS.filter(usable);
    const picked = available[Math.floor(Math.random() * available.length)];

    current = picked ?? current;

    return picked;
  };

  const searchRandom = async (
    query: string,
    signal: AbortSignal
  ): Promise<readonly SearchHit[]> => {
    const attempted = new Set<ProviderId>();
    let lastError: SearchError | undefined;

    for (
      let id = pickRandom(attempted);
      id !== undefined;
      id = pickRandom(attempted)
    ) {
      attempted.add(id);

      try {
        // Providers run one at a time: each failover depends on the previous answer.
        // oxlint-disable-next-line no-await-in-loop
        return await runProvider(PROVIDERS[id], query, secrets, signal);
      } catch (error) {
        if (!(error instanceof SearchError) || !isRateLimit(error.cause)) {
          throw error;
        }

        const now = Date.now();

        cooldowns.set(id, {
          error,
          until: now + cooldownMs(error.cause.retryAfter, now),
        });
        lastError = error;
      }
    }

    throw (
      lastError ??
      [...cooldowns.values()][0]?.error ??
      new Error("No web search provider is available")
    );
  };

  return async (query, provider, signal) => {
    const fixed = provider ?? (selection === "random" ? undefined : selection);

    return fixed === undefined
      ? await searchRandom(query, signal)
      : await runProvider(PROVIDERS[fixed], query, secrets, signal);
  };
};

const formatHit = (item: SearchHit): string => {
  const published =
    item.published === undefined
      ? ""
      : `\nPublished: ${new Date(item.published).toISOString()}`;

  const content = item.content === undefined ? "" : `\n\n${item.content}`;

  return `## [${item.title ?? item.url}](${item.url})${published}${content}`;
};

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- A caught value has no type.
const errorText = (error: unknown, query: string): string => {
  if (!(error instanceof SearchError)) {
    return `Unable to search the web for ${query}`;
  }

  const { cause, provider } = error;

  if (!(cause instanceof HttpStatusError)) {
    const reason = cause instanceof Error ? `: ${cause.message}` : "";

    return `Unable to search the web for ${query} with ${provider.name}${reason}`;
  }

  if (cause.status === HTTP_TOO_MANY_REQUESTS) {
    return `Web search rate limited (HTTP 429) by ${provider.name}`;
  }

  if (cause.status === HTTP_UNAUTHORIZED) {
    return `Web search authentication failed (HTTP 401) at ${provider.name}. Check the ${provider.secret} secret.`;
  }

  return `Web search request failed (HTTP ${cause.status}) at ${provider.name}`;
};

const textResult = (text: string): ToolResult => ({
  content: [{ text, type: "text" }],
});

const errorResult = (text: string): ToolResult => ({
  content: [{ text, type: "text" }],
  isError: true,
});

/** Creates the `search` Tool of one Agent. */
export const createSearchTool = (
  selection: Selection,
  secrets: SecretReader
): Tool<SearchInput> => {
  const search = createSearcher(selection, secrets);

  return defineTool<SearchInput>({
    description: `Search the web. Use this for current information beyond your knowledge cutoff. Returns Markdown results with titles, links, and excerpts.

The current year is ${new Date().getFullYear()}. Use this year when you search for recent information or current events.`,
    execute: async ({ query, provider }, ctx) => {
      try {
        const hits = await search(query, provider, ctx.signal);

        return textResult(
          hits.length === 0 ? NO_RESULTS : hits.map(formatHit).join("\n\n")
        );
      } catch (error) {
        if (ctx.signal.aborted) {
          throw error;
        }

        return errorResult(errorText(error, query));
      }
    },
    inputSchema: toJsonSchema(SearchInputSchema),
    name: "search",
  });
};
