import type { JsonObject } from "@wheatley-ai/sdk";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { pluginTool, resultText, toolContext } from "./test-support.js";

/** One request that the Plugin sent to the fake network. */
interface SentRequest {
  readonly url: URL;
  readonly headers: Headers;
  readonly body: unknown;
}

type Route = (request: SentRequest) => Response;

const JsonRpcMethod = Type.Object({ method: Type.String() });

let routes = new Map<string, Route>();
let sent: SentRequest[] = [];

/** An MCP `tools/call` response as one SSE event. */
const mcpEvent = (
  result: JsonObject,
  headers: Readonly<Record<string, string>> = {}
): Response =>
  new Response(
    `event: message\ndata: ${JSON.stringify({ id: 1, jsonrpc: "2.0", result })}\n\n`,
    { headers: { "content-type": "text/event-stream", ...headers } }
  );

/** An MCP `tools/call` result with one text block. */
const mcpText = (text: string): Response =>
  mcpEvent({ content: [{ text, type: "text" }] });

const status = (
  code: number,
  headers: Readonly<Record<string, string>> = {}
): Response => new Response("", { headers, status: code });

beforeEach(() => {
  routes = new Map();
  sent = [];
  vi.stubGlobal(
    "fetch",
    async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(input);
      const text = await new Response(init?.body).text();
      const body: unknown = text === "" ? null : JSON.parse(text);
      const request = { body, headers: new Headers(init?.headers), url };
      const route = routes.get(url.host);

      sent.push(request);

      if (route === undefined) {
        throw new TypeError(`fetch failed: no route for ${url.host}`);
      }

      return route(request);
    }
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const search = async (
  input: { readonly query: string; readonly provider?: string },
  config: Parameters<typeof pluginTool>[1] = {},
  secrets: Readonly<Record<string, string>> = {}
) => {
  const tool = await pluginTool("search", config, secrets);

  return await tool.execute(input, toolContext());
};

it("formats Exa results and sends the API key as a query parameter", async () => {
  routes.set("mcp.exa.ai", () =>
    mcpText(
      [
        "Title: Alpha\nURL: https://a.example/\nPublished: 2026-01-02T00:00:00.000Z\nText: First result",
        "Title: N/A\nURL: https://b.example/\nPublished: N/A\nHighlights:\nSecond result",
      ].join("\n\n---\n\n")
    )
  );

  const result = await search(
    { query: "alpha" },
    { provider: "exa" },
    { EXA_API_KEY: "exa-key" }
  );

  expect(result).toStrictEqual({
    content: [
      {
        text: "## [Alpha](https://a.example/)\nPublished: 2026-01-02T00:00:00.000Z\n\nFirst result\n\n## [https://b.example/](https://b.example/)\n\nSecond result",
        type: "text",
      },
    ],
  });
  expect(sent[0]?.url.searchParams.get("exaApiKey")).toBe("exa-key");
  expect(sent[0]?.body).toMatchObject({
    method: "tools/call",
    params: { arguments: { query: "alpha" }, name: "web_search_exa" },
  });
});

it("formats Firecrawl results and sends the API key as a bearer token", async () => {
  routes.set("mcp.firecrawl.dev", () =>
    mcpText(
      JSON.stringify({
        data: {
          web: [
            {
              description: "Docs",
              title: "Firecrawl",
              url: "https://f.example/",
            },
            { description: null, title: null, url: "https://g.example/" },
          ],
        },
        success: true,
      })
    )
  );

  const result = await search(
    { query: "crawl" },
    { provider: "firecrawl" },
    { FIRECRAWL_API_KEY: "fc-key" }
  );

  expect(resultText(result)).toBe(
    "## [Firecrawl](https://f.example/)\n\nDocs\n\n## [https://g.example/](https://g.example/)"
  );
  expect(sent[0]?.headers.get("authorization")).toBe("Bearer fc-key");
});

it("formats Parallel results from the structured content and joins excerpts", async () => {
  routes.set("search.parallel.ai", () =>
    mcpEvent({
      content: [{ text: "ignored", type: "text" }],
      structuredContent: {
        results: [
          {
            excerpts: ["One", "Two"],
            publish_date: "2025-05-06",
            title: "Parallel",
            url: "https://p.example/",
          },
        ],
        search_id: "s-1",
        session_id: "x",
      },
    })
  );

  const result = await search({ provider: "parallel", query: "parallel" });

  expect(resultText(result)).toBe(
    "## [Parallel](https://p.example/)\nPublished: 2025-05-06T00:00:00.000Z\n\nOne\n\nTwo"
  );
  expect(sent[0]?.headers.has("authorization")).toBe(false);
  expect(sent[0]?.body).toMatchObject({
    params: {
      arguments: { objective: "parallel", search_queries: ["parallel"] },
    },
  });
});

it("formats Tavily results and switches between keyless and keyed access", async () => {
  routes.set("api.tavily.com", () =>
    Response.json({
      results: [
        { content: "Tavily text", title: "Tavily", url: "https://t.example/" },
      ],
    })
  );

  const keyless = await search({ query: "t" }, { provider: "tavily" });

  const keyed = await search(
    { query: "t" },
    { provider: "tavily" },
    { TAVILY_API_KEY: "tv-key" }
  );

  expect(resultText(keyless)).toBe(
    "## [Tavily](https://t.example/)\n\nTavily text"
  );
  expect(resultText(keyed)).toBe(resultText(keyless));
  expect(sent[0]?.headers.get("x-tavily-access-mode")).toBe("keyless");
  expect(sent[1]?.headers.get("authorization")).toBe("Bearer tv-key");
  expect(sent[1]?.headers.has("x-tavily-access-mode")).toBe(false);
});

it("opens a TinyFish MCP session only for keyed access", async () => {
  routes.set("agent.tinyfish.ai", ({ body }) => {
    const method = Value.Check(JsonRpcMethod, body) ? body.method : "";

    if (method === "initialize") {
      return mcpEvent({}, { "mcp-session-id": "session-7" });
    }

    if (method === "notifications/initialized") {
      return status(202);
    }

    return mcpText(
      JSON.stringify({
        results: [
          { snippet: "Fish", title: "TinyFish", url: "https://tf.example/" },
        ],
      })
    );
  });

  const keyless = await search({ provider: "tinyfish", query: "fish" });

  expect(resultText(keyless)).toBe(
    "## [TinyFish](https://tf.example/)\n\nFish"
  );
  expect(sent).toHaveLength(1);
  expect(sent[0]?.headers.get("x-tinyfish-access-mode")).toBe("keyless");

  sent = [];
  await search(
    { provider: "tinyfish", query: "fish" },
    {},
    { TINYFISH_API_KEY: "tf-key" }
  );

  expect(sent.map(({ body }) => body)).toMatchObject([
    { method: "initialize" },
    { method: "notifications/initialized" },
    { method: "tools/call" },
  ]);
  expect(sent[2]?.headers.get("mcp-session-id")).toBe("session-7");
  expect(sent[2]?.headers.get("x-api-key")).toBe("tf-key");
});

it("reports no results, HTTP 429, HTTP 401, other statuses, and network failures", async () => {
  const responses = [
    () => Response.json({ results: [] }),
    () => status(429),
    () => status(401),
    () => status(503),
  ];

  routes.set("api.tavily.com", () => {
    const next = responses.shift();

    if (next === undefined) {
      throw new TypeError("fetch failed");
    }

    return next();
  });

  const texts = [];

  for (let call = 0; call < 5; call += 1) {
    // oxlint-disable-next-line no-await-in-loop
    const result = await search({ query: "q" }, { provider: "tavily" });

    texts.push([resultText(result), result.isError ?? false]);
  }

  expect(texts).toStrictEqual([
    ["No search results found. Please try a different query.", false],
    ["Web search rate limited (HTTP 429) by Tavily", true],
    [
      "Web search authentication failed (HTTP 401) at Tavily. Check the TAVILY_API_KEY secret.",
      true,
    ],
    ["Web search request failed (HTTP 503) at Tavily", true],
    ["Unable to search the web for q with Tavily: fetch failed", true],
  ]);
});

/** Routes every provider to an empty result, and records the provider order of the calls. */
const routeAllProviders = (limited: Set<string>, retryAfter = "30") => {
  const ok = {
    "agent.tinyfish.ai": () => mcpText(JSON.stringify({ results: [] })),
    "api.tavily.com": () => Response.json({ results: [] }),
    "mcp.exa.ai": () => mcpText(""),
    "mcp.firecrawl.dev": () => mcpText(JSON.stringify({ data: { web: [] } })),
    "search.parallel.ai": () => mcpEvent({ content: [] }),
  };

  for (const [host, respond] of Object.entries(ok)) {
    routes.set(host, () =>
      limited.has(host) ? status(429, { "retry-after": retryAfter }) : respond()
    );
  }
};

const hosts = (): string[] => sent.map(({ url }) => url.host);

it("keeps one random provider until it is rate limited, then fails over and cools it down", async () => {
  let now = 1_000_000;

  vi.spyOn(Date, "now").mockImplementation(() => now);
  vi.spyOn(Math, "random").mockReturnValue(0);

  const limited = new Set<string>();

  routeAllProviders(limited);

  const tool = await pluginTool("search");
  const run = async () => await tool.execute({ query: "q" }, toolContext());

  await run();
  await run();

  expect(hosts()).toStrictEqual(["mcp.exa.ai", "mcp.exa.ai"]);

  sent = [];
  limited.add("mcp.exa.ai");
  await run();
  await run();

  expect(hosts()).toStrictEqual([
    "mcp.exa.ai",
    "mcp.firecrawl.dev",
    "mcp.firecrawl.dev",
  ]);

  sent = [];
  limited.add("mcp.firecrawl.dev");
  limited.delete("mcp.exa.ai");
  now += 31_000;
  await run();

  // The Exa cooldown of 30 seconds ended, so Exa is available again.
  expect(hosts()).toStrictEqual(["mcp.firecrawl.dev", "mcp.exa.ai"]);
});

it("reports a rate limit when every provider is on cooldown, without new requests", async () => {
  vi.spyOn(Math, "random").mockReturnValue(0);
  routeAllProviders(
    new Set([
      "agent.tinyfish.ai",
      "api.tavily.com",
      "mcp.exa.ai",
      "mcp.firecrawl.dev",
      "search.parallel.ai",
    ])
  );

  const tool = await pluginTool("search");
  const first = await tool.execute({ query: "q" }, toolContext());

  expect(hosts()).toHaveLength(5);
  expect(first.isError).toBe(true);
  expect(resultText(first)).toMatch(/^Web search rate limited \(HTTP 429\)/u);

  sent = [];
  const second = await tool.execute({ query: "q" }, toolContext());

  expect(sent).toHaveLength(0);
  expect(resultText(second)).toMatch(/^Web search rate limited \(HTTP 429\)/u);
});

it("does not fail over a call that names its provider", async () => {
  routeAllProviders(new Set(["api.tavily.com"]));

  const result = await search({ provider: "tavily", query: "q" });

  expect(hosts()).toStrictEqual(["api.tavily.com"]);
  expect(resultText(result)).toBe(
    "Web search rate limited (HTTP 429) by Tavily"
  );
});
