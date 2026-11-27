import { Type } from "typebox";
import type { TSchema, Static } from "typebox";
import { Value } from "typebox/value";

import {
  assertOk,
  MAX_PROVIDER_RESPONSE_BYTES,
  PROVIDER_TIMEOUT_MS,
  readTextWithin,
  USER_AGENT,
  withTimeout,
} from "./http.js";
import { callMcpTool, firstText, postMcp } from "./mcp.js";

/** The search providers of the Plugin, in a fixed order. */
export const PROVIDER_IDS = [
  "exa",
  "firecrawl",
  "parallel",
  "tavily",
  "tinyfish",
] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

/** One search result, independent of the provider. */
export interface SearchHit {
  readonly url: string;
  readonly title?: string;
  readonly content?: string;
  /** The publication time in milliseconds since the epoch. */
  readonly published?: number;
}

/** One search request to one provider. */
export interface ProviderRequest {
  readonly query: string;
  /** The provider API key, or `undefined` for keyless access. */
  readonly apiKey: string | undefined;
  readonly signal: AbortSignal;
}

/** One search provider adapter. */
export interface SearchProvider {
  readonly id: ProviderId;
  /** The display name in Tool output and errors. */
  readonly name: string;
  /** The secret name that holds the API key. */
  readonly secret: string;
  /**
   * Runs one search.
   *
   * Errors: rejects with `HttpStatusError` for a non-2xx status, or with another `Error` for a network failure, a
   * time-out, or a malformed response.
   */
  readonly search: (request: ProviderRequest) => Promise<readonly SearchHit[]>;
}

/** The number of results that Wheatley requests from providers that accept a limit. */
const RESULT_LIMIT = 8;

const TAVILY_CHUNKS_PER_SOURCE = 3;

const MCP_PROTOCOL_VERSION = "2025-06-18";

const EXA_BLOCK_SEPARATOR = /\n\n---\n\n/u;
const EXA_URL = /^URL:\s*(?<value>.+)$/mu;
const EXA_TITLE = /^Title:\s*(?<value>.+)$/mu;
const EXA_PUBLISHED = /^Published:\s*(?<value>.+)$/mu;
const EXA_CONTENT = /^(?:Highlights|Text):\s*\n?(?<value>[\s\S]*)$/mu;

/** The value that Exa writes for a missing field. */
const EXA_MISSING = "N/A";

/** A provider field that can be missing, `null`, or empty. */
type MaybeText = string | null | undefined;

const isPresent = (value: MaybeText): value is string =>
  value !== undefined && value !== null && value !== "";

/** Builds a hit. Empty fields and unparseable dates become `undefined`. */
const toHit = (fields: {
  readonly url: string;
  readonly title?: MaybeText;
  readonly content?: MaybeText;
  readonly published?: MaybeText;
}): SearchHit => {
  const published = isPresent(fields.published)
    ? Date.parse(fields.published)
    : Number.NaN;

  return {
    content: isPresent(fields.content) ? fields.content : undefined,
    published: Number.isFinite(published) ? published : undefined,
    title: isPresent(fields.title) ? fields.title : undefined,
    url: fields.url,
  };
};

/** Parses the JSON text of an MCP text block against `schema`, or returns `undefined`. */
const parseJsonText = <Schema extends TSchema>(
  schema: Schema,
  text: string | undefined
): Static<Schema> | undefined => {
  if (text === undefined) {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(text);

    return Value.Check(schema, parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

const bearer = (apiKey: string | undefined): Readonly<Record<string, string>> =>
  apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` };

const matchField = (block: string, pattern: RegExp): string | undefined => {
  const value = pattern.exec(block)?.groups?.value?.trim();

  return value === undefined || value === EXA_MISSING ? undefined : value;
};

/** Parses the text that the Exa MCP `web_search_exa` Tool returns: blocks of `Title:`, `URL:`, and content lines. */
const parseExaText = (text: string): SearchHit[] =>
  text.split(EXA_BLOCK_SEPARATOR).flatMap((block) => {
    const url = matchField(block, EXA_URL);

    if (url === undefined) {
      return [];
    }

    return [
      toHit({
        content: EXA_CONTENT.exec(block)?.groups?.value?.trim(),
        published: matchField(block, EXA_PUBLISHED),
        title: matchField(block, EXA_TITLE),
        url,
      }),
    ];
  });

const exa: SearchProvider = {
  id: "exa",
  name: "Exa",
  search: async ({ query, apiKey, signal }) => {
    const url = new URL("https://mcp.exa.ai/mcp");

    if (apiKey !== undefined) {
      url.searchParams.set("exaApiKey", apiKey);
    }

    const result = await callMcpTool({
      arguments: { numResults: RESULT_LIMIT, query },
      headers: { "user-agent": USER_AGENT },
      signal,
      tool: "web_search_exa",
      url: url.href,
    });

    const text = firstText(result);

    return text === undefined ? [] : parseExaText(text);
  },
  secret: "EXA_API_KEY",
};

const FirecrawlResponse = Type.Object({
  data: Type.Object({
    web: Type.Array(
      Type.Object({
        description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        title: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        url: Type.String(),
      })
    ),
  }),
});

const firecrawl: SearchProvider = {
  id: "firecrawl",
  name: "Firecrawl",
  search: async ({ query, apiKey, signal }) => {
    const result = await callMcpTool({
      arguments: { limit: RESULT_LIMIT, query },
      headers: { "user-agent": USER_AGENT, ...bearer(apiKey) },
      signal,
      tool: "firecrawl_search",
      url: "https://mcp.firecrawl.dev/v2/mcp",
    });

    const response = parseJsonText(FirecrawlResponse, firstText(result));

    return (response?.data.web ?? []).map((item) =>
      toHit({ content: item.description, title: item.title, url: item.url })
    );
  },
  secret: "FIRECRAWL_API_KEY",
};

const ParallelResponse = Type.Object({
  results: Type.Array(
    Type.Object({
      excerpts: Type.Array(Type.String()),
      publish_date: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      title: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      url: Type.String(),
    })
  ),
});

const parallel: SearchProvider = {
  id: "parallel",
  name: "Parallel",
  search: async ({ query, apiKey, signal }) => {
    const result = await callMcpTool({
      arguments: { objective: query, search_queries: [query] },
      headers: { "user-agent": USER_AGENT, ...bearer(apiKey) },
      signal,
      tool: "web_search",
      url: "https://search.parallel.ai/mcp",
    });

    const structured = result?.structuredContent;

    if (!Value.Check(ParallelResponse, structured)) {
      return [];
    }

    return structured.results.map((item) =>
      toHit({
        content: item.excerpts.join("\n\n"),
        published: item.publish_date,
        title: item.title,
        url: item.url,
      })
    );
  },
  secret: "PARALLEL_API_KEY",
};

const TavilyResponse = Type.Object({
  results: Type.Array(
    Type.Object({
      content: Type.String(),
      title: Type.String(),
      url: Type.String(),
    })
  ),
});

const tavily: SearchProvider = {
  id: "tavily",
  name: "Tavily",
  search: async ({ query, apiKey, signal }) => {
    const response = await fetch("https://api.tavily.com/search", {
      body: JSON.stringify({
        chunks_per_source: TAVILY_CHUNKS_PER_SOURCE,
        max_results: RESULT_LIMIT,
        query,
        search_depth: "basic",
      }),
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": USER_AGENT,
        "x-client-name": "wheatley",
        ...(apiKey === undefined
          ? { "x-tavily-access-mode": "keyless" }
          : bearer(apiKey)),
      },
      method: "POST",
      signal: withTimeout(signal, PROVIDER_TIMEOUT_MS),
    });

    await assertOk("Tavily search", response);

    const body = parseJsonText(
      TavilyResponse,
      await readTextWithin(
        response,
        MAX_PROVIDER_RESPONSE_BYTES,
        () =>
          new Error(
            `Tavily response exceeded ${MAX_PROVIDER_RESPONSE_BYTES} bytes`
          )
      )
    );

    if (body === undefined) {
      throw new Error("Tavily returned a malformed response");
    }

    return body.results.map((item) =>
      toHit({ content: item.content, title: item.title, url: item.url })
    );
  },
  secret: "TAVILY_API_KEY",
};

const TINYFISH_ENDPOINT = "https://agent.tinyfish.ai/mcp";

const TinyFishResponse = Type.Object({
  results: Type.Array(
    Type.Object({
      snippet: Type.String(),
      title: Type.String(),
      url: Type.String(),
    })
  ),
});

/** Opens a TinyFish MCP session and returns its `Mcp-Session-Id`. Keyed requests fail without one. */
const openTinyFishSession = async (
  headers: Readonly<Record<string, string>>,
  signal: AbortSignal
): Promise<string> => {
  const response = await postMcp({
    body: {
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: { name: "wheatley", version: "1.0" },
        protocolVersion: MCP_PROTOCOL_VERSION,
      },
    },
    headers,
    label: "TinyFish initialize",
    signal,
    url: TINYFISH_ENDPOINT,
  });

  await readTextWithin(
    response,
    MAX_PROVIDER_RESPONSE_BYTES,
    () =>
      new Error(
        `TinyFish initialize response exceeded ${MAX_PROVIDER_RESPONSE_BYTES} bytes`
      )
  );

  const session = response.headers.get("mcp-session-id");

  if (session === null) {
    throw new Error(
      "TinyFish MCP initialize did not return an Mcp-Session-Id header"
    );
  }

  const initialized = await postMcp({
    body: { jsonrpc: "2.0", method: "notifications/initialized" },
    headers: { ...headers, "mcp-session-id": session },
    label: "TinyFish initialized notification",
    signal,
    url: TINYFISH_ENDPOINT,
  });

  await initialized.body?.cancel();

  return session;
};

const tinyfish: SearchProvider = {
  id: "tinyfish",
  name: "TinyFish",
  search: async ({ query, apiKey, signal }) => {
    const headers: Readonly<Record<string, string>> =
      apiKey === undefined
        ? { "user-agent": USER_AGENT, "x-tinyfish-access-mode": "keyless" }
        : { "user-agent": USER_AGENT, "x-api-key": apiKey };

    const session: Readonly<Record<string, string>> =
      apiKey === undefined
        ? {}
        : { "mcp-session-id": await openTinyFishSession(headers, signal) };

    const result = await callMcpTool({
      arguments: { query },
      headers: { ...headers, ...session },
      signal,
      tool: "search",
      url: TINYFISH_ENDPOINT,
    });

    const response = parseJsonText(TinyFishResponse, firstText(result));

    return (response?.results ?? []).map((item) =>
      toHit({ content: item.snippet, title: item.title, url: item.url })
    );
  },
  secret: "TINYFISH_API_KEY",
};

/** The search provider adapters by ID. */
export const PROVIDERS: Readonly<Record<ProviderId, SearchProvider>> = {
  exa,
  firecrawl,
  parallel,
  tavily,
  tinyfish,
};
