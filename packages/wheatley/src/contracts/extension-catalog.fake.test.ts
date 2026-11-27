import type { Frontend, Logger, Tool, ToolContext } from "@wheatley-ai/sdk";
import { beforeEach, describe, expect, it } from "vitest";

import { InMemoryExtensionCatalog } from "./extension-catalog.fake.js";
import type {
  ProviderInput,
  SkillProvider,
  ToolProvider,
} from "./extension-catalog.js";
import { InMemorySecretStore } from "./secret-store.fake.js";
import { FakeToolProvider } from "./tool-provider.fake.js";

const silentLog: Logger = {
  debug: () => {},
  error: () => {},
  info: () => {},
  warn: () => {},
};

const providerInput: ProviderInput = {
  agentDir: "/data/agents/home",
  agentName: "home",
  config: { model: "test/model-1" },
  homeDir: "/data",
  log: silentLog,
  secrets: new InMemorySecretStore({}),
  signal: new AbortController().signal,
};

const toolContext = (signal = new AbortController().signal): ToolContext => ({
  agentName: "home",
  chat: { bindingId: "tg", chatId: "1" },
  conversationId: "conversation-1",
  log: silentLog,
  runId: "run-1",
  signal,
  toolCallId: "call-1",
  workspaceDir: "/data/agents/home/workspace",
});

const echoTool = (name: string): Tool => ({
  description: `Echoes input for ${name}`,
  execute: async (input) => {
    await Promise.resolve();

    return {
      content: [{ text: `${name}:${JSON.stringify(input)}`, type: "text" }],
    };
  },
  inputSchema: { type: "object" },
  name,
});

const throwingTool: Tool = {
  description: "Always fails",
  execute: async () => {
    await Promise.resolve();
    throw new Error("disk full");
  },
  inputSchema: { type: "object" },
  name: "broken",
};

const telegram: Frontend = {
  configSchema: { type: "object" },
  createBinding: () => {
    throw new Error("Not used in this test");
  },
  type: "telegram",
};

let builtin: FakeToolProvider;
let plugins: FakeToolProvider;
let catalog: InMemoryExtensionCatalog;

beforeEach(() => {
  builtin = new FakeToolProvider("builtin", [
    { name: "shell", tool: echoTool("shell") },
  ]);
  plugins = new FakeToolProvider(
    "plugin",
    [
      { name: "notes:add", tool: echoTool("add") },
      { name: "notes:broken", tool: throwingTool },
    ],
    [
      { name: "notes", state: "ready" },
      { error: "Cannot find module", name: "weather", state: "failed" },
    ]
  );
  catalog = new InMemoryExtensionCatalog(() => ({
    builtin,
    frontends: [telegram],
    plugins: [plugins],
  }));
});

describe("InMemoryExtensionCatalog", () => {
  it("lists the Tools of every provider in provider order with unique canonical names", async () => {
    const extensions = await catalog.createAgentExtensions(providerInput);
    const tools = extensions.tools();

    expect(
      tools.map((tool) => [tool.name, tool.source, tool.defaultAction])
    ).toStrictEqual([
      ["shell", "builtin", "allow"],
      ["notes:add", "plugin", "ask"],
      ["notes:broken", "plugin", "ask"],
    ]);
    expect(new Set(tools.map((tool) => tool.name)).size).toBe(tools.length);
  });

  it("runs a Tool through the provider that owns its canonical name", async () => {
    const extensions = await catalog.createAgentExtensions(providerInput);

    await expect(
      extensions.executeTool("notes:add", { text: "milk" }, toolContext())
    ).resolves.toStrictEqual({
      content: [{ text: 'add:{"text":"milk"}', type: "text" }],
    });
    await expect(
      extensions.executeTool("shell", { cmd: "ls" }, toolContext())
    ).resolves.toStrictEqual({
      content: [{ text: 'shell:{"cmd":"ls"}', type: "text" }],
    });
  });

  it.each([
    ["an unknown Tool", "notes:missing", new AbortController().signal],
    ["a Tool that throws", "notes:broken", new AbortController().signal],
    ["an aborted call", "notes:add", AbortSignal.abort()],
  ])(
    "resolves an error result for %s instead of a rejection",
    async (_label, name, signal) => {
      const extensions = await catalog.createAgentExtensions(providerInput);

      const result = await extensions.executeTool(
        name,
        {},
        toolContext(signal)
      );

      expect(result.isError).toBe(true);
      expect(result.content.length).toBeGreaterThan(0);
    }
  );

  it("starts the Agent without a failed Plugin and reports the failure in health", async () => {
    const extensions = await catalog.createAgentExtensions(providerInput);

    expect(extensions.health()).toStrictEqual({
      mcpServers: [],
      plugins: [
        { name: "notes", state: "ready" },
        { error: "Cannot find module", name: "weather", state: "failed" },
      ],
      skillWarnings: [],
    });
    expect(
      extensions.tools().some((tool) => tool.name.startsWith("weather:"))
    ).toBe(false);
  });

  it("maps Frontends by type", async () => {
    const extensions = await catalog.createAgentExtensions(providerInput);

    expect(extensions.frontends().get("telegram")).toBe(telegram);
    expect(extensions.frontends().size).toBe(1);
  });

  it("closes every provider also if one of them fails to close", async () => {
    const failing: ToolProvider = {
      close: async () => {
        await Promise.resolve();
        throw new Error("MCP Server did not answer");
      },
      execute: builtin.execute,
      health: () => [],
      tools: () => [],
    };

    const failingFirst = new InMemoryExtensionCatalog(() => ({
      builtin: failing,
      plugins: [plugins],
    }));

    const extensions = await failingFirst.createAgentExtensions(providerInput);

    await expect(extensions.close()).resolves.toBeUndefined();
    expect(plugins.closed).toBe(true);
  });

  it("reports MCP health and Skill warnings apart from Plugin health", async () => {
    const mcp = new FakeToolProvider(
      "mcp",
      [],
      [{ error: "connect ECONNREFUSED", name: "github", state: "failed" }]
    );

    const readSkill = new FakeToolProvider("builtin", [
      { name: "read_skill", tool: echoTool("read_skill") },
    ]);

    const skills: SkillProvider = {
      catalogPrompt: () => "- pdf: Read PDF files",
      close: readSkill.close,
      execute: readSkill.execute,
      health: readSkill.health,
      tools: readSkill.tools,
      skills: () => [
        {
          description: "Read PDF files",
          name: "pdf",
          origin: "shared",
          path: "/data/skills/pdf/SKILL.md",
        },
      ],
      warnings: () => ["skills/broken/SKILL.md has no name"],
    };

    const full = new InMemoryExtensionCatalog(() => ({
      builtin,
      mcp,
      plugins: [plugins],
      skills,
    }));

    const extensions = await full.createAgentExtensions(providerInput);

    expect(extensions.health()).toStrictEqual({
      mcpServers: [
        { error: "connect ECONNREFUSED", name: "github", state: "failed" },
      ],
      plugins: [
        { name: "notes", state: "ready" },
        { error: "Cannot find module", name: "weather", state: "failed" },
      ],
      skillWarnings: ["skills/broken/SKILL.md has no name"],
    });
    expect(extensions.skillCatalogPrompt()).toBe("- pdf: Read PDF files");
    expect(extensions.skills().map((skill) => skill.name)).toStrictEqual([
      "pdf",
    ]);
    expect(extensions.tools().at(-1)?.name).toBe("read_skill");
  });

  it("gives each Agent its own provider instances", async () => {
    const created: FakeToolProvider[] = [];

    const perAgent = new InMemoryExtensionCatalog(() => {
      const provider = new FakeToolProvider("builtin", [
        { name: "shell", tool: echoTool("shell") },
      ]);

      created.push(provider);

      return { builtin: provider };
    });

    const home = await perAgent.createAgentExtensions(providerInput);
    await perAgent.createAgentExtensions({
      ...providerInput,
      agentName: "work",
    });

    await home.close();

    expect(created.map((provider) => provider.closed)).toStrictEqual([
      true,
      false,
    ]);
  });

  it("rejects a setup in which two providers offer the same Tool name", async () => {
    const clash = new InMemoryExtensionCatalog(() => ({
      builtin,
      plugins: [
        new FakeToolProvider("plugin", [
          { name: "shell", tool: echoTool("shell") },
        ]),
      ],
    }));

    await expect(clash.createAgentExtensions(providerInput)).rejects.toThrow(
      "Two providers offer the Tool shell"
    );
  });
});
