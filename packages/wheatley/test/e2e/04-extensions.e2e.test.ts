// Flow 4 of issue #50: Plugin, MCP Server, and Skill loading with Permission Policy enforcement and namespaced Tool
// names. A broken Plugin degrades only itself.
import { once } from "node:events";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { buffer } from "node:stream/consumers";

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type {
  AssistantMessage,
  FauxResponseFactory,
  Message,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import {
  createMcpHandler,
  fromJsonSchema,
  McpServer,
} from "@modelcontextprotocol/server";
import type { ApprovalRequestedDelivery } from "@wheatley/sdk";
import { afterEach, beforeEach, expect, it } from "vitest";

import { startHarness, waitFor } from "./harness.js";
import type { Harness } from "./harness.js";

const FIXTURES = path.join(import.meta.dirname, "fixtures", "04-extensions");
const NOTES_PLUGIN = path.join(FIXTURES, "notes-plugin.ts");
const BROKEN_PLUGIN = path.join(FIXTURES, "broken-plugin.ts");
const MISSING_PLUGIN = "./plugins/absent.mjs";
const STDIO_SERVER = path.join(FIXTURES, "stdio-server.ts");

const HTTP_TOKEN = "Bearer e2e-http-token";
const STDIO_TOKEN = "e2e-stdio-token-value";
const BINDING = "fake-main";
const CHAT = "chat-1";

/** A Streamable HTTP MCP Server that requires `Authorization: ${HTTP_TOKEN}` and counts its Tool calls. */
interface HttpMcpServer {
  readonly url: string;
  readonly calls: () => number;
  readonly close: () => Promise<void>;
}

const isAddressInfo = (
  address: ReturnType<Server["address"]>
): address is AddressInfo => address !== null && typeof address !== "string";

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
      body.cancel().catch(() => {
        // The client closed the stream first.
      });
    });

    try {
      for await (const chunk of body) {
        res.write(chunk);
      }
    } catch {
      // The client closed the stream, for example when the daemon stops.
    }
  }

  res.end();
};

const startHttpMcpServer = async (): Promise<HttpMcpServer> => {
  let calls = 0;

  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: "e2e-http", version: "1.0.0" });

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
        calls += 1;

        return { content: [], structuredContent: { sum: a + b } };
      }
    );

    return server;
  });

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

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();

  if (!isAddressInfo(address)) {
    throw new Error("The HTTP MCP Server has no TCP port");
  }

  return {
    calls: () => calls,
    close: async () => {
      server.closeAllConnections();
      await handler.close();
      server.close();
      await once(server, "close");
    },
    url: `http://127.0.0.1:${address.port}/mcp`,
  };
};

const SKILL_GREETING = `---
name: greeting
description: Greets the user in the house style.
---
Say "Ahoy" before every greeting.
`;

const SKILL_PACKING = `---
name: packing
description: Packs a bag for a trip.
---
Pack light.
`;

const SKILL_INVALID = `---
name: other-name
description: Its name differs from its folder.
---
Body.
`;

const writeSkill = async (
  root: string,
  name: string,
  text: string
): Promise<string> => {
  const dir = path.join(root, name);

  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "SKILL.md"), text);

  return dir;
};

/** Writes a shared Skill with a bundled file, an Agent Skill, and an invalid shared Skill. */
const prepareSkills = async (homeDir: string): Promise<void> => {
  const shared = path.join(homeDir, "skills");
  const greeting = await writeSkill(shared, "greeting", SKILL_GREETING);

  await mkdir(path.join(greeting, "references"), { recursive: true });
  await writeFile(
    path.join(greeting, "references", "phrases.md"),
    "Ahoy, matey."
  );
  await writeSkill(shared, "mismatch", SKILL_INVALID);
  await writeSkill(
    path.join(homeDir, "agents", "home", "skills"),
    "packing",
    SKILL_PACKING
  );
};

/** The model contexts that the fake LLM received, in call order. */
const contexts: (readonly Message[])[] = [];

/** A scripted model response that records the context it receives. */
const reply =
  (message: AssistantMessage): FauxResponseFactory =>
  (context) => {
    contexts.push([...context.messages]);

    return message;
  };

const isToolResult = (message: Message): message is ToolResultMessage =>
  message.role === "toolResult";

/** The Tool result with `toolCallId` that the model received, or `undefined` before it arrived. */
const toolResultOf = (toolCallId: string): ToolResultMessage | undefined =>
  contexts
    .flat()
    .filter(isToolResult)
    .find((message) => message.toolCallId === toolCallId);

const textOf = (message: ToolResultMessage | undefined): string =>
  (message?.content ?? [])
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");

const systemText = (messages: readonly Message[]): string =>
  messages
    .flatMap((message) => {
      if (message.role !== "system") {
        return [];
      }

      const content = Array.isArray(message.content)
        ? message.content.map((block) => block.text).join("")
        : message.content;

      return [content, ...Object.values(message.sections ?? {})];
    })
    .join("\n");

const exists = async (target: string): Promise<boolean> => {
  try {
    await stat(target);

    return true;
  } catch {
    return false;
  }
};

let h: Harness;
let http: HttpMcpServer;

beforeEach(async () => {
  contexts.length = 0;
  http = await startHttpMcpServer();
  h = await startHarness({
    agents: {
      home: {
        frontends: [
          { config: { allowedChatIds: [CHAT] }, id: BINDING, type: "fake" },
        ],
        mcpServers: {
          local: {
            args: [STDIO_SERVER],
            command: process.execPath,
            env: { FIXTURE_TOKEN: { secret: "STDIO_TOKEN" } },
            transport: "stdio",
          },
          remote: {
            headers: { Authorization: { secret: "HTTP_TOKEN" } },
            transport: "http",
            url: http.url,
          },
        },
        permissionPolicy: [
          { action: "deny", tool: "notes:wipe" },
          { action: "allow", tool: "notes:*" },
          { action: "allow", tool: "mcp:local:*" },
        ],
        plugins: [
          { config: { prefix: "noted: " }, source: NOTES_PLUGIN },
          { source: BROKEN_PLUGIN },
          { source: MISSING_PLUGIN },
        ],
      },
    },
    prepare: prepareSkills,
    secrets: { HTTP_TOKEN, STDIO_TOKEN },
  });
});

afterEach(async () => {
  await h.cleanup();
  await http.close();
});

it("lists namespaced Plugin, MCP, and Skill Tools with Policy actions, and a broken Plugin fails alone", async () => {
  const session = await h.connect();
  const status = await session.request("system.status", {});

  expect(status.agents.map((agent) => [agent.name, agent.state])).toEqual([
    ["home", "running"],
  ]);

  const listed = await session.request("extensions.list", { agent: "home" });

  const tools = Object.fromEntries(
    listed.tools.map((tool) => [tool.name, [tool.source, tool.action]])
  );

  expect(tools).toMatchObject({
    "mcp:local:echo": ["mcp", "allow"],
    "mcp:local:read-token": ["mcp", "allow"],
    "mcp:remote:add": ["mcp", "ask"],
    "notes:add": ["plugin", "allow"],
    "notes:wipe": ["plugin", "deny"],
    read_skill: ["builtin", "allow"],
  });
  expect(
    Object.keys(tools).filter((name) => name.startsWith("broken"))
  ).toEqual([]);

  expect(listed.plugins.map(({ name, state }) => [name, state])).toEqual([
    ["notes", "ready"],
    ["broken", "failed"],
    [MISSING_PLUGIN, "failed"],
  ]);
  expect(listed.plugins[0]?.error).toBeUndefined();
  expect(listed.plugins[1]?.error).toBe("Plugin setup failed: missing token");
  expect(listed.plugins[2]?.error).toContain("absent.mjs");
  expect(listed.mcpServers).toEqual([
    { name: "local", state: "ready" },
    { name: "remote", state: "ready" },
  ]);
  expect(
    Object.fromEntries(listed.skills.map((skill) => [skill.name, skill.origin]))
  ).toEqual({ greeting: "shared", packing: "agent" });
  expect(status.agents[0]?.skillWarnings).toEqual([
    expect.stringContaining("mismatch"),
  ]);
});

it("runs allowed Plugin and stdio MCP Tools and returns their results to the model", async () => {
  const session = await h.connect();

  h.llm.faux.setResponses([
    reply(
      fauxAssistantMessage(
        [
          fauxToolCall("notes__add", { text: "buy milk" }, { id: "call-add" }),
          fauxToolCall(
            "mcp__local__echo",
            { text: "ping" },
            { id: "call-echo" }
          ),
          fauxToolCall("mcp__local__read-token", {}, { id: "call-token" }),
        ],
        { stopReason: "toolUse" }
      )
    ),
    reply(fauxAssistantMessage("All Tools ran")),
  ]);

  const asked = await h.cli(["ask", "--agent", "home", "Use the Tools"]);

  expect(asked).toMatchObject({ code: 0 });
  expect(asked.stdout).toContain("All Tools ran");

  expect(toolResultOf("call-add")).toMatchObject({ isError: false });
  expect(textOf(toolResultOf("call-add"))).toBe("noted: buy milk");
  expect(textOf(toolResultOf("call-echo"))).toBe("ping");
  expect(textOf(toolResultOf("call-token"))).toBe(STDIO_TOKEN);

  expect(
    await readFile(
      path.join(h.agentDir(), "plugins", "notes", "notes.txt"),
      "utf-8"
    )
  ).toBe("buy milk\n");

  const finished = await session.waitForEvent(
    "run.toolFinished",
    (event) => event.toolName === "mcp:local:read-token"
  );

  expect(finished.isError).toBe(false);
  expect(finished.outputPreview).not.toContain(STDIO_TOKEN);
});

it("denies a Tool that the Permission Policy denies and asks before a default-ask MCP Tool", async () => {
  h.llm.faux.setResponses([
    reply(
      fauxAssistantMessage(
        fauxToolCall("notes__wipe", {}, { id: "call-wipe" }),
        {
          stopReason: "toolUse",
        }
      )
    ),
    reply(
      fauxAssistantMessage(
        fauxToolCall("mcp__remote__add", { a: 2, b: 3 }, { id: "call-sum" }),
        { stopReason: "toolUse" }
      )
    ),
    reply(fauxAssistantMessage("The sum is 5")),
  ]);

  await h.frontend.send("home", BINDING, CHAT, "Wipe, then add 2 and 3");

  const binding = h.frontend.binding("home", BINDING);

  const approval = await waitFor(
    () =>
      binding.deliveries.find(
        (delivery): delivery is ApprovalRequestedDelivery =>
          delivery.kind === "approval_requested"
      ),
    "the Approval request for mcp:remote:add"
  );

  expect(approval.toolName).toBe("mcp:remote:add");
  expect(http.calls()).toBe(0);

  await expect(
    h.frontend.decide("home", BINDING, CHAT, approval.approvalId, {
      decision: "allow_once",
    })
  ).resolves.toBe(true);

  const final = await waitFor(
    () =>
      binding.deliveries.find(
        (delivery) =>
          delivery.kind === "message" && delivery.text === "The sum is 5"
      ),
    "the final reply"
  );

  expect(final).toMatchObject({ chatId: CHAT, source: "reply" });

  expect(toolResultOf("call-wipe")).toMatchObject({ isError: true });
  expect(textOf(toolResultOf("call-wipe"))).toContain(
    "The Permission Policy denies notes:wipe"
  );
  expect(
    await exists(path.join(h.agentDir(), "plugins", "notes", "wiped"))
  ).toBe(false);

  expect(http.calls()).toBe(1);
  expect(JSON.parse(textOf(toolResultOf("call-sum")))).toEqual({ sum: 5 });
});

it("refuses a default-ask MCP Tool in a non-interactive Run without calling the server", async () => {
  h.llm.faux.setResponses([
    reply(
      fauxAssistantMessage(
        fauxToolCall("mcp__remote__add", { a: 1, b: 1 }, { id: "call-sum" }),
        { stopReason: "toolUse" }
      )
    ),
    reply(fauxAssistantMessage("I could not add")),
  ]);

  const asked = await h.cli(["ask", "--agent", "home", "Add 1 and 1"]);

  expect(asked).toMatchObject({ code: 0 });
  expect(asked.stdout).toContain("I could not add");
  expect(toolResultOf("call-sum")).toMatchObject({ isError: true });
  expect(textOf(toolResultOf("call-sum"))).toContain(
    "mcp:remote:add needs an Approval"
  );
  expect(http.calls()).toBe(0);
});

it("offers the Skill catalog in the instructions and discloses a Skill and its bundled file with read_skill", async () => {
  h.llm.faux.setResponses([
    reply(
      fauxAssistantMessage(
        [
          fauxToolCall(
            "read_skill",
            { name: "greeting" },
            { id: "call-skill" }
          ),
          fauxToolCall(
            "read_skill",
            { name: "greeting", path: "references/phrases.md" },
            { id: "call-file" }
          ),
          fauxToolCall("read_skill", { name: "mismatch" }, { id: "call-bad" }),
        ],
        { stopReason: "toolUse" }
      )
    ),
    reply(fauxAssistantMessage("Ahoy")),
  ]);

  const asked = await h.cli(["ask", "--agent", "home", "Greet me"]);

  expect(asked.stdout).toContain("Ahoy");

  const [first] = contexts;
  const instructions = systemText(first ?? []);

  expect(instructions).toContain(
    "- greeting: Greets the user in the house style."
  );
  expect(instructions).toContain("- packing: Packs a bag for a trip.");
  expect(instructions).not.toContain("mismatch");

  expect(textOf(toolResultOf("call-skill"))).toContain(
    'Say "Ahoy" before every greeting.'
  );
  expect(textOf(toolResultOf("call-file"))).toContain("Ahoy, matey.");
  expect(toolResultOf("call-bad")).toMatchObject({ isError: true });
  expect(textOf(toolResultOf("call-bad"))).toContain("Unknown Skill: mismatch");
});
