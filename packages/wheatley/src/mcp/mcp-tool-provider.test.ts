import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { buffer } from "node:stream/consumers";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import {
  createMcpHandler,
  fromJsonSchema,
  McpServer,
} from "@modelcontextprotocol/server";
import type {
  AgentConfig,
  JsonValue,
  McpServerConfig,
  StringOrSecret,
} from "@wheatley/protocol";
import type { Logger, ToolContext, ToolResult } from "@wheatley/sdk";
import { afterEach, expect, it, vi } from "vitest";

import type {
  ProviderInput,
  ToolProvider,
} from "../contracts/extension-catalog.js";
import { migrationNamespace, systemClock } from "../contracts/module.js";
import type { AgentModuleContext } from "../contracts/module.js";
import { InMemorySecretStore } from "../contracts/secret-store.fake.js";
import { openAgentDatabase } from "../db/database.js";
import { runMigrations } from "../db/migrations.js";
import { mcpModule } from "./mcp-module.js";
import { createMcpToolProvider } from "./mcp-tool-provider.js";

const TEST_TIMEOUT_MS = 30_000;
const SLOW_TOOL_DELAY_MS = 10_000;
const ABORT_DELAY_MS = 100;
const HTTP_TOKEN = "Bearer http-secret-value";
const STDIO_TOKEN = "stdio-secret-value";

const fixture = fileURLToPath(
  new URL("fixtures/stdio-server.mjs", import.meta.url)
);

const silentLog: Logger = {
  debug: () => {},
  error: () => {},
  info: () => {},
  warn: () => {},
};

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  const pending = cleanups.splice(0).toReversed();

  for (const cleanup of pending) {
    // oxlint-disable-next-line no-await-in-loop -- Cleanups run one at a time, in reverse order of setup.
    await cleanup();
  }
});

const stdioServer = (
  env?: Readonly<Record<string, StringOrSecret>>
): McpServerConfig => ({
  args: [fixture],
  command: process.execPath,
  env: { FIXTURE_TOKEN: { secret: "STDIO_TOKEN" }, ...env },
  transport: "stdio",
});

const agentConfig = (
  mcpServers: Readonly<Record<string, McpServerConfig>>
): AgentConfig => ({
  mcpServers,
  model: { id: "test-model", provider: "test" },
});

const secrets = new InMemorySecretStore({
  HTTP_TOKEN,
  STDIO_TOKEN,
  WRONG_TOKEN: "Bearer wrong-value",
});

const providerInput = (
  mcpServers: Readonly<Record<string, McpServerConfig>>,
  signal: AbortSignal = new AbortController().signal
): ProviderInput => ({
  agentDir: process.cwd(),
  agentName: "home",
  config: agentConfig(mcpServers),
  homeDir: process.cwd(),
  log: silentLog,
  secrets,
  signal,
});

const connect = async (
  mcpServers: Readonly<Record<string, McpServerConfig>>
): Promise<ToolProvider> => {
  const provider = await createMcpToolProvider(providerInput(mcpServers));

  cleanups.push(provider.close);

  return provider;
};

const moduleContext = (): AgentModuleContext => {
  const db = openAgentDatabase(":memory:");

  cleanups.push(async () => {
    await Promise.resolve();
    db.close();
  });
  runMigrations(db, [migrationNamespace(mcpModule)]);

  return {
    agentDir: process.cwd(),
    agentName: "home",
    clock: systemClock,
    db,
    events: { emit: () => {} },
    log: silentLog,
  };
};

const toolContext = (
  signal: AbortSignal = new AbortController().signal
): ToolContext => ({
  agentName: "home",
  chat: null,
  conversationId: "conversation-1",
  log: silentLog,
  runId: "run-1",
  signal,
  toolCallId: "call-1",
  workspaceDir: process.cwd(),
});

const run = async (
  provider: ToolProvider,
  name: string,
  input: JsonValue = {},
  signal?: AbortSignal
): Promise<ToolResult> =>
  await provider.execute(name, input, toolContext(signal));

const firstText = (result: ToolResult): string => {
  const [block] = result.content;

  return block?.type === "text" ? block.text : "";
};

const toolNames = (provider: ToolProvider): readonly string[] =>
  provider
    .tools()
    .map((tool) => tool.name)
    .toSorted();

const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
};

interface HttpFixture {
  readonly url: string;
  /** The `tools/call` requests that reached the server's Tools. */
  readonly calls: () => number;
}

const createHttpMcpServer = (countCall: () => void): McpServer => {
  const server = new McpServer({ name: "fixture-http", version: "1.0.0" });

  server.registerTool(
    "add",
    {
      description: "Adds two numbers",
      inputSchema: fromJsonSchema<{ a: number; b: number }>({
        properties: { a: { type: "number" }, b: { type: "number" } },
        required: ["a", "b"],
        type: "object",
      }),
    },
    ({ a, b }) => {
      countCall();

      return { content: [], structuredContent: { sum: a + b } };
    }
  );

  server.registerTool(
    "slow",
    {
      description: "Waits ten seconds",
      inputSchema: fromJsonSchema({ properties: {}, type: "object" }),
    },
    async () => {
      countCall();
      await delay(SLOW_TOOL_DELAY_MS, undefined, { ref: false });

      return { content: [{ text: "done", type: "text" }] };
    }
  );

  return server;
};

const isAddressInfo = (
  address: ReturnType<Server["address"]>
): address is AddressInfo => address !== null && typeof address !== "string";

const listen = async (server: Server): Promise<number> => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();

  if (!isAddressInfo(address)) {
    throw new Error("The test server has no TCP port");
  }

  return address.port;
};

const closeServer = async (server: Server): Promise<void> => {
  server.close();
  await once(server, "close");
};

const toRequest = async (request: IncomingMessage): Promise<Request> => {
  const headers = new Headers();

  for (const [key, value] of Object.entries(request.headers)) {
    for (const item of [value ?? []].flat()) {
      headers.append(key, item);
    }
  }

  const hasBody = request.method !== "GET" && request.method !== "HEAD";

  return new Request(`http://localhost${request.url ?? "/"}`, {
    body: hasBody ? await buffer(request) : undefined,
    headers,
    method: request.method ?? "GET",
  });
};

const sendResponse = async (
  response: Response,
  res: ServerResponse
): Promise<void> => {
  res.writeHead(response.status, Object.fromEntries(response.headers));

  const { body } = response;

  if (body !== null) {
    res.on("close", () => {
      body.cancel().catch(() => {});
    });

    try {
      for await (const chunk of body) {
        res.write(chunk);
      }
    } catch {
      // The client closed the stream, for example when the provider closes.
    }
  }

  res.end();
};

/** Serves a Streamable HTTP MCP Server that requires `Authorization: ${HTTP_TOKEN}`. */
const startHttpServer = async (): Promise<HttpFixture> => {
  let calls = 0;

  const handler = createMcpHandler(() =>
    createHttpMcpServer(() => {
      calls += 1;
    })
  );

  const serve = async (
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> => {
    if (req.headers.authorization !== HTTP_TOKEN) {
      res.writeHead(401).end();

      return;
    }

    await sendResponse(await handler.fetch(await toRequest(req)), res);
  };

  const server = createServer((req, res) => {
    serve(req, res).catch(() => {
      res.destroy();
    });
  });

  const port = await listen(server);

  cleanups.push(async () => {
    server.closeAllConnections();
    await handler.close();
    await closeServer(server);
  });

  return { calls: () => calls, url: `http://127.0.0.1:${port}/mcp` };
};

/** Returns a local URL where no server listens. */
const closedUrl = async (): Promise<string> => {
  const server = createServer();
  const port = await listen(server);

  await closeServer(server);

  return `http://127.0.0.1:${port}/mcp`;
};

const httpServer = (url: string, secret = "HTTP_TOKEN"): McpServerConfig => ({
  headers: { Authorization: { secret } },
  transport: "http",
  url,
});

it(
  "connects a stdio MCP Server and runs its Tools as mcp:<server>:<tool>",
  async () => {
    const provider = await connect({ local: stdioServer() });

    expect(toolNames(provider)).toStrictEqual([
      "mcp:local:crash",
      "mcp:local:echo",
      "mcp:local:fail",
      "mcp:local:pid",
      "mcp:local:read-token",
    ]);
    expect(
      provider.tools().find((tool) => tool.name === "mcp:local:echo")
    ).toMatchObject({
      defaultAction: "ask",
      description: "Returns the text",
      inputSchema: { properties: { text: { type: "string" } } },
      source: "mcp",
    });
    expect(provider.health()).toStrictEqual([
      { name: "local", state: "ready" },
    ]);

    await expect(
      run(provider, "mcp:local:echo", { text: "hello" })
    ).resolves.toStrictEqual({ content: [{ text: "hello", type: "text" }] });
    await expect(run(provider, "mcp:local:fail")).resolves.toStrictEqual({
      content: [{ text: "it broke", type: "text" }],
      isError: true,
    });
  },
  TEST_TIMEOUT_MS
);

it(
  "passes secrets from secrets.yaml to stdio env and HTTP headers",
  async () => {
    const http = await startHttpServer();

    const provider = await connect({
      local: stdioServer(),
      remote: httpServer(http.url),
    });

    expect(firstText(await run(provider, "mcp:local:read-token"))).toBe(
      STDIO_TOKEN
    );
    expect(provider.health()).toStrictEqual([
      { name: "local", state: "ready" },
      { name: "remote", state: "ready" },
    ]);
  },
  TEST_TIMEOUT_MS
);

it(
  "connects a Streamable HTTP MCP Server and converts structured output to text",
  async () => {
    const http = await startHttpServer();
    const provider = await connect({ remote: httpServer(http.url) });

    expect(toolNames(provider)).toStrictEqual([
      "mcp:remote:add",
      "mcp:remote:slow",
    ]);
    await expect(
      run(provider, "mcp:remote:add", { a: 2, b: 3 })
    ).resolves.toStrictEqual({
      content: [{ text: '{"sum":5}', type: "text" }],
    });
    expect(http.calls()).toBe(1);
  },
  TEST_TIMEOUT_MS
);

it(
  "rejects input that breaks the Tool's schema before it calls the server",
  async () => {
    const http = await startHttpServer();
    const provider = await connect({ remote: httpServer(http.url) });

    const result = await run(provider, "mcp:remote:add", { a: "two", b: 3 });

    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("Invalid input for mcp:remote:add");
    expect(http.calls()).toBe(0);
  },
  TEST_TIMEOUT_MS
);

it(
  "returns an error result when ToolContext.signal aborts a call",
  async () => {
    const http = await startHttpServer();
    const provider = await connect({ remote: httpServer(http.url) });
    const controller = new AbortController();

    setTimeout(() => {
      controller.abort();
    }, ABORT_DELAY_MS);

    await expect(
      run(provider, "mcp:remote:slow", {}, controller.signal)
    ).resolves.toStrictEqual({
      content: [{ text: "mcp:remote:slow was aborted", type: "text" }],
      isError: true,
    });
  },
  TEST_TIMEOUT_MS
);

it(
  "starts with the working MCP Servers when other servers fail to connect",
  async () => {
    const http = await startHttpServer();

    const provider = await connect({
      broken: {
        command: "/nonexistent/wheatley-mcp-server",
        transport: "stdio",
      },
      denied: httpServer(http.url, "WRONG_TOKEN"),
      local: stdioServer(),
      nosecret: stdioServer({ OTHER: { secret: "MISSING_SECRET" } }),
      off: { ...stdioServer(), enabled: false },
      offline: httpServer(await closedUrl()),
    });

    expect(toolNames(provider)).toStrictEqual([
      "mcp:local:crash",
      "mcp:local:echo",
      "mcp:local:fail",
      "mcp:local:pid",
      "mcp:local:read-token",
    ]);

    const health = new Map(
      provider.health().map((status) => [status.name, status])
    );

    expect(health.get("local")).toStrictEqual({
      name: "local",
      state: "ready",
    });
    expect(health.get("off")).toStrictEqual({ name: "off", state: "disabled" });
    expect(health.get("nosecret")).toStrictEqual({
      error: "Unknown secret: MISSING_SECRET",
      name: "nosecret",
      state: "failed",
    });

    for (const name of ["broken", "denied", "offline"]) {
      expect(health.get(name)?.state).toBe("failed");
      expect(health.get(name)?.error?.length).toBeGreaterThan(0);
    }

    await expect(
      run(provider, "mcp:local:echo", { text: "still here" })
    ).resolves.toStrictEqual({
      content: [{ text: "still here", type: "text" }],
    });
  },
  TEST_TIMEOUT_MS
);

it(
  "removes only the Tools of an MCP Server that disconnects after it connected",
  async () => {
    const provider = await connect({
      first: stdioServer(),
      second: stdioServer(),
    });

    const crash = await run(provider, "mcp:first:crash");

    expect(crash.isError).toBe(true);
    await vi.waitFor(() => {
      expect(provider.health()).toStrictEqual([
        { error: "Connection closed", name: "first", state: "failed" },
        { name: "second", state: "ready" },
      ]);
    });
    expect(
      toolNames(provider).every((name) => name.startsWith("mcp:second:"))
    ).toBe(true);
    const unavailable = await run(provider, "mcp:first:echo", { text: "x" });

    expect(unavailable).toStrictEqual({
      content: [
        {
          text: "MCP Server first is not available: Connection closed",
          type: "text",
        },
      ],
      isError: true,
    });
    await expect(
      run(provider, "mcp:second:echo", { text: "ok" })
    ).resolves.toStrictEqual({ content: [{ text: "ok", type: "text" }] });
  },
  TEST_TIMEOUT_MS
);

it(
  "reports an unknown Tool as an error result",
  async () => {
    const provider = await connect({ local: stdioServer() });

    await expect(run(provider, "mcp:local:missing")).resolves.toStrictEqual({
      content: [{ text: "Unknown Tool: mcp:local:missing", type: "text" }],
      isError: true,
    });
  },
  TEST_TIMEOUT_MS
);

it(
  "close ends stdio server processes and reports every server as stopped",
  async () => {
    const provider = await connect({
      local: stdioServer(),
      off: { ...stdioServer(), enabled: false },
    });

    const pid = Number(firstText(await run(provider, "mcp:local:pid")));

    expect(isRunning(pid)).toBe(true);

    await provider.close();

    expect(provider.health()).toStrictEqual([
      { name: "local", state: "stopped" },
      { name: "off", state: "disabled" },
    ]);
    expect(provider.tools()).toStrictEqual([]);
    const afterClose = await run(provider, "mcp:local:echo", { text: "x" });

    expect(afterClose.isError).toBe(true);
    await vi.waitFor(() => {
      expect(isRunning(pid)).toBe(false);
    });
  },
  TEST_TIMEOUT_MS
);

it(
  "runs as an Agent module: start connects and stop closes",
  async () => {
    const instance = await mcpModule.create(moduleContext(), {
      config: agentConfig({ local: stdioServer() }),
      secrets,
    });

    expect(instance.api.tools()).toStrictEqual([]);
    expect(instance.api.health()).toStrictEqual([
      { name: "local", state: "starting" },
    ]);

    await instance.start?.();

    expect(firstText(await run(instance.api, "mcp:local:read-token"))).toBe(
      STDIO_TOKEN
    );

    await instance.stop?.();

    expect(instance.api.health()).toStrictEqual([
      { name: "local", state: "stopped" },
    ]);
  },
  TEST_TIMEOUT_MS
);

it(
  "stop during start aborts the connects and resolves",
  async () => {
    const http = await startHttpServer();

    const instance = await mcpModule.create(moduleContext(), {
      config: agentConfig({
        local: stdioServer(),
        remote: httpServer(http.url),
      }),
      secrets,
    });

    const starting = instance.start?.();

    await instance.stop?.();
    await starting;

    expect(instance.api.health()).toStrictEqual([
      { name: "local", state: "stopped" },
      { name: "remote", state: "stopped" },
    ]);
    expect(instance.api.tools()).toStrictEqual([]);
  },
  TEST_TIMEOUT_MS
);
