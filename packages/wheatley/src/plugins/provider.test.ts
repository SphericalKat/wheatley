import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { AgentConfig, PluginConfig } from "@wheatley-ai/protocol";
import type { Logger, ToolContext } from "@wheatley-ai/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  PluginProvider,
  ProviderInput,
} from "../contracts/extension-catalog.js";
import { InMemorySecretStore } from "../contracts/secret-store.fake.js";
import { createPluginProvider } from "./provider.js";
import type { PluginProviderOptions } from "./provider.js";

const SHORT_TIMEOUT_MS = 50;

const silentLog: Logger = {
  debug: () => {},
  error: () => {},
  info: () => {},
  warn: () => {},
};

let homeDir = "";
let agentDir = "";
let provider: PluginProvider | undefined;

beforeEach(async () => {
  homeDir = await mkdtemp(path.join(tmpdir(), "wheatley-plugins-"));
  agentDir = path.join(homeDir, "agents", "home");
  await mkdir(agentDir, { recursive: true });
});

afterEach(async () => {
  await provider?.close();
  provider = undefined;
  await rm(homeDir, { force: true, recursive: true });
});

/** Writes a Plugin module below the Deployment home and returns its `source` relative to the home. */
const writeLocalPlugin = async (
  file: string,
  code: string
): Promise<string> => {
  const target = path.join(homeDir, "plugins", file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, code);

  return `./plugins/${file}`;
};

/** Installs an ESM-only npm package in `<home>/extensions/node_modules/`. */
const installPackage = async (name: string, code: string): Promise<void> => {
  const dir = path.join(homeDir, "extensions", "node_modules", name);
  await mkdir(path.join(dir, "dist"), { recursive: true });
  await writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({
      exports: { ".": { import: "./dist/plugin.js" } },
      name,
      type: "module",
      version: "1.0.0",
    })
  );
  await writeFile(path.join(dir, "dist", "plugin.js"), code);
};

const load = async (
  plugins: readonly PluginConfig[],
  options: PluginProviderOptions = {},
  overrides: Partial<ProviderInput> = {}
): Promise<PluginProvider> => {
  const config: AgentConfig = {
    model: { id: "model-1", provider: "test" },
    plugins: [...plugins],
  };

  provider = await createPluginProvider(
    {
      agentDir,
      agentName: "home",
      config,
      homeDir,
      log: silentLog,
      secrets: new InMemorySecretStore({ NOTES_TOKEN: "secret-value" }),
      signal: new AbortController().signal,
      ...overrides,
    },
    options
  );

  return provider;
};

const toolContext = (signal = new AbortController().signal): ToolContext => ({
  agentName: "home",
  chat: null,
  conversationId: "conversation-1",
  log: silentLog,
  runId: "run-1",
  signal,
  toolCallId: "call-1",
  workspaceDir: agentDir,
});

/** A Plugin with one Tool `add` that echoes `text`, and a `dispose` that writes `disposed` into its data folder. */
const notesPlugin = (name = "notes", apiVersion = "1"): string => `
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export default {
  apiVersion: ${apiVersion},
  name: ${JSON.stringify(name)},
  version: "1.0.0",
  setup: (ctx) => ({
    tools: [
      {
        name: "add",
        description: "Adds a note",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string", minLength: 1 } },
          required: ["text"],
          additionalProperties: false,
        },
        execute: async (input, toolCtx) => ({
          content: [{ type: "text", text: ctx.agentName + ":" + toolCtx.runId + ":" + input.text }],
        }),
      },
    ],
    dispose: async () => {
      await writeFile(join(ctx.dataDir, "disposed"), "yes");
    },
  }),
};
`;

/** A Plugin that contributes a `matrix` Frontend and writes `disposed` into its data folder on dispose. */
const frontendPlugin = (name: string): string => `
  import { writeFile } from "node:fs/promises";
  import { join } from "node:path";
  export default {
    apiVersion: 1,
    name: ${JSON.stringify(name)},
    version: "1.0.0",
    setup: (ctx) => ({
      frontends: [{
        type: "matrix",
        configSchema: { type: "object" },
        createBinding: () => { throw new Error("not used"); },
      }],
      dispose: async () => { await writeFile(join(ctx.dataDir, "disposed"), "yes"); },
    }),
  };`;

const statusOf = (loaded: PluginProvider, name: string) =>
  loaded.health().find((status) => status.name === name);

describe("Plugin loader", () => {
  it("loads a local Plugin and names its Tools <plugin>:<tool>", async () => {
    const source = await writeLocalPlugin("notes.mjs", notesPlugin());
    const loaded = await load([{ source }]);

    expect(loaded.health()).toStrictEqual([{ name: "notes", state: "ready" }]);
    expect(loaded.tools()).toStrictEqual([
      {
        defaultAction: "ask",
        description: "Adds a note",
        inputSchema: {
          additionalProperties: false,
          properties: { text: { minLength: 1, type: "string" } },
          required: ["text"],
          type: "object",
        },
        name: "notes:add",
        source: "plugin",
      },
    ]);
    await expect(
      loaded.execute("notes:add", { text: "milk" }, toolContext())
    ).resolves.toStrictEqual({
      content: [{ text: "home:run-1:milk", type: "text" }],
    });
  });

  it("loads an npm package Plugin from the extensions folder through its exports map", async () => {
    await installPackage(
      "wheatley-plugin-weather",
      `export default {
        apiVersion: 1,
        name: "weather",
        version: "2.1.0",
        setup: () => ({
          tools: [{
            name: "forecast",
            description: "Returns the forecast",
            inputSchema: { type: "object" },
            execute: async () => ({ content: [{ type: "text", text: "sunny" }] }),
          }],
        }),
      };`
    );

    const loaded = await load([{ source: "wheatley-plugin-weather" }]);

    expect(loaded.health()).toStrictEqual([
      { name: "weather", state: "ready" },
    ]);
    expect(loaded.tools().map((tool) => tool.name)).toStrictEqual([
      "weather:forecast",
    ]);
    await expect(
      loaded.execute("weather:forecast", {}, toolContext())
    ).resolves.toStrictEqual({ content: [{ text: "sunny", type: "text" }] });
  });

  it("rejects a Plugin whose apiVersion is not the integer 1 and still loads the other Plugins", async () => {
    const two = await writeLocalPlugin("two.mjs", notesPlugin("two", "2"));
    const text = await writeLocalPlugin("text.mjs", notesPlugin("text", '"1"'));
    const good = await writeLocalPlugin("good.mjs", notesPlugin("good"));

    const loaded = await load([
      { source: two },
      { source: text },
      { source: good },
    ]);

    expect(loaded.health()).toStrictEqual([
      {
        error:
          "The Plugin declares apiVersion 2, but Wheatley supports only apiVersion 1",
        name: two,
        state: "failed",
      },
      {
        error:
          "The Plugin declares apiVersion '1', but Wheatley supports only apiVersion 1",
        name: text,
        state: "failed",
      },
      { name: "good", state: "ready" },
    ]);
    expect(loaded.tools().map((tool) => tool.name)).toStrictEqual(["good:add"]);
  });

  it("isolates load failures so the remaining Plugins load and the provider resolves", async () => {
    const throwsOnImport = await writeLocalPlugin(
      "import-error.mjs",
      'throw new Error("boom on import");'
    );

    const noDefault = await writeLocalPlugin(
      "no-default.mjs",
      "export const plugin = {};"
    );

    const setupThrows = await writeLocalPlugin(
      "setup-throws.mjs",
      `export default { apiVersion: 1, name: "broken", version: "1.0.0", setup: () => { throw new Error("missing token"); } };`
    );

    const hangs = await writeLocalPlugin(
      "hangs.mjs",
      `export default { apiVersion: 1, name: "slow", version: "1.0.0", setup: () => new Promise(() => {}) };`
    );

    const badTool = await writeLocalPlugin(
      "bad-tool.mjs",
      `export default { apiVersion: 1, name: "badtool", version: "1.0.0", setup: () => ({
        tools: [{ name: "Bad:Name", description: "x", inputSchema: { type: "object" }, execute: async () => ({ content: [] }) }],
      }) };`
    );

    const reserved = await writeLocalPlugin("mcp.mjs", notesPlugin("mcp"));
    const good = await writeLocalPlugin("good.mjs", notesPlugin("good"));

    const loaded = await load(
      [
        { source: throwsOnImport },
        { source: noDefault },
        { source: setupThrows },
        { source: hangs },
        { source: badTool },
        { source: reserved },
        { source: "wheatley-plugin-missing" },
        { source: good },
      ],
      { disposeTimeoutMs: SHORT_TIMEOUT_MS, setupTimeoutMs: SHORT_TIMEOUT_MS }
    );

    const missing = statusOf(loaded, "wheatley-plugin-missing");

    expect(loaded.health()).toStrictEqual([
      { error: "boom on import", name: throwsOnImport, state: "failed" },
      {
        error: "The module has no default export",
        name: noDefault,
        state: "failed",
      },
      {
        error: "Plugin setup failed: missing token",
        name: "broken",
        state: "failed",
      },
      {
        error: `Plugin setup timed out after ${SHORT_TIMEOUT_MS} ms`,
        name: "slow",
        state: "failed",
      },
      {
        error: "Invalid Tool name: Bad:Name",
        name: "badtool",
        state: "failed",
      },
      {
        error:
          "Invalid Plugin name 'mcp': it must match ^[a-z][a-z0-9_-]*$ and must not be mcp",
        name: reserved,
        state: "failed",
      },
      {
        error: missing?.error,
        name: "wheatley-plugin-missing",
        state: "failed",
      },
      { name: "good", state: "ready" },
    ]);
    expect(missing?.error).toContain(
      "Cannot find package 'wheatley-plugin-missing'"
    );
    expect(loaded.tools().map((tool) => tool.name)).toStrictEqual(["good:add"]);
  });

  it("disposes the contributions of a setup that finishes after its time limit before close resolves", async () => {
    const source = await writeLocalPlugin(
      "late.mjs",
      `import { writeFile } from "node:fs/promises";
      import { join } from "node:path";
      export default { apiVersion: 1, name: "late", version: "1.0.0", setup: async (ctx) => {
        await new Promise((resolve) => { setTimeout(resolve, ${SHORT_TIMEOUT_MS * 2}); });
        return { dispose: async () => { await writeFile(join(ctx.dataDir, "disposed"), "yes"); } };
      } };`
    );

    const loaded = await load([{ source }], {
      setupTimeoutMs: SHORT_TIMEOUT_MS,
    });

    expect(statusOf(loaded, "late")?.state).toBe("failed");

    await loaded.close();

    await expect(
      readFile(path.join(agentDir, "plugins", "late", "disposed"), "utf-8")
    ).resolves.toBe("yes");
  });

  it("reports disabled entries without importing them", async () => {
    const source = await writeLocalPlugin(
      "never.mjs",
      'throw new Error("imported");'
    );

    const loaded = await load([{ enabled: false, source }]);

    expect(loaded.health()).toStrictEqual([
      { name: source, state: "disabled" },
    ]);
    expect(loaded.tools()).toStrictEqual([]);
  });

  it("fails the later of two entries with the same Plugin name", async () => {
    const first = await writeLocalPlugin("first.mjs", notesPlugin());
    const second = await writeLocalPlugin("second.mjs", notesPlugin());
    const loaded = await load([{ source: first }, { source: second }]);

    expect(loaded.health()).toStrictEqual([
      { name: "notes", state: "ready" },
      {
        error: `Another plugins entry already loaded a Plugin named notes (source ${second})`,
        name: "notes",
        state: "failed",
      },
    ]);
  });

  it("validates Tool input against plain JSON Schema before execute runs", async () => {
    const source = await writeLocalPlugin("notes.mjs", notesPlugin());
    const loaded = await load([{ source }]);

    await expect(
      loaded.execute("notes:add", { text: "" }, toolContext())
    ).resolves.toStrictEqual({
      content: [
        {
          text: "Invalid input for notes:add: /text: expected at least 1 characters",
          type: "text",
        },
      ],
      isError: true,
    });
  });

  it("accepts Standard JSON Schema Tool input, offers the converted schema, and runs the library validator", async () => {
    const source = await writeLocalPlugin(
      "standard.mjs",
      `const shout = {
        "~standard": {
          version: 1,
          vendor: "test",
          jsonSchema: {
            input: () => ({ type: "object", properties: { word: { type: "string" } }, required: ["word"] }),
            output: () => ({ type: "object" }),
          },
          validate: (value) =>
            typeof value?.word === "string"
              ? { value: { word: value.word.toUpperCase() } }
              : { issues: [{ message: "word is required", path: [{ key: "word" }] }] },
        },
      };
      export default {
        apiVersion: 1,
        name: "shout",
        version: "1.0.0",
        setup: () => ({
          tools: [{
            name: "say",
            description: "Shouts a word",
            inputSchema: shout,
            execute: async (input) => ({ content: [{ type: "text", text: input.word }] }),
          }],
        }),
      };`
    );

    const loaded = await load([{ source }]);

    expect(loaded.tools()[0]?.inputSchema).toStrictEqual({
      properties: { word: { type: "string" } },
      required: ["word"],
      type: "object",
    });
    await expect(
      loaded.execute("shout:say", { word: "hi" }, toolContext())
    ).resolves.toStrictEqual({ content: [{ text: "HI", type: "text" }] });
    await expect(
      loaded.execute("shout:say", {}, toolContext())
    ).resolves.toStrictEqual({
      content: [
        {
          text: "Invalid input for shout:say: /word: word is required",
          type: "text",
        },
      ],
      isError: true,
    });
  });

  it("validates the Plugin config block against configSchema and gives setup a data folder and secrets", async () => {
    const source = await writeLocalPlugin(
      "configured.mjs",
      `import { writeFile } from "node:fs/promises";
      import { join } from "node:path";
      export default {
        apiVersion: 1,
        name: "configured",
        version: "1.0.0",
        configSchema: {
          type: "object",
          properties: { folder: { type: "string" } },
          required: ["folder"],
        },
        setup: async (ctx) => {
          await writeFile(join(ctx.dataDir, "setup.json"), JSON.stringify({
            config: ctx.config,
            hasToken: ctx.secrets.get("NOTES_TOKEN") === "secret-value",
          }));
          return {};
        },
      };`
    );

    const loaded = await load([{ config: { folder: "inbox" }, source }]);

    expect(loaded.health()).toStrictEqual([
      { name: "configured", state: "ready" },
    ]);

    const written = await readFile(
      path.join(agentDir, "plugins", "configured", "setup.json"),
      "utf-8"
    );

    expect(JSON.parse(written)).toStrictEqual({
      config: { folder: "inbox" },
      hasToken: true,
    });
  });

  it("reports a config block that breaks configSchema", async () => {
    const source = await writeLocalPlugin(
      "strict.mjs",
      `export default {
        apiVersion: 1,
        name: "strict",
        version: "1.0.0",
        configSchema: { type: "object", required: ["folder"] },
        setup: () => ({}),
      };`
    );

    const loaded = await load([{ source }]);

    expect(statusOf(loaded, "strict")).toStrictEqual({
      error: "Invalid Plugin config: /folder: missing",
      name: "strict",
      state: "failed",
    });
  });

  it("collects Plugin Frontends and fails a later Plugin that repeats a Frontend type", async () => {
    const first = await writeLocalPlugin(
      "matrix-a.mjs",
      frontendPlugin("matrix_a")
    );

    const second = await writeLocalPlugin(
      "matrix-b.mjs",
      frontendPlugin("matrix_b")
    );

    const loaded = await load([{ source: first }, { source: second }]);

    expect(loaded.frontends().map((frontend) => frontend.type)).toStrictEqual([
      "matrix",
    ]);
    expect(loaded.health()).toStrictEqual([
      { name: "matrix_a", state: "ready" },
      {
        error: "Plugin matrix_a already contributes the Frontend type matrix",
        name: "matrix_b",
        state: "failed",
      },
    ]);
    await expect(
      readFile(path.join(agentDir, "plugins", "matrix_b", "disposed"), "utf-8")
    ).resolves.toBe("yes");
  });

  it("turns a throw, an invalid result, and an abort of a Tool into error results", async () => {
    const source = await writeLocalPlugin(
      "faulty.mjs",
      `export default {
        apiVersion: 1,
        name: "faulty",
        version: "1.0.0",
        setup: () => ({
          tools: [
            { name: "throws", description: "x", inputSchema: { type: "object" }, execute: async () => { throw new Error("disk full"); } },
            { name: "garbage", description: "x", inputSchema: { type: "object" }, execute: async () => "not a result" },
            { name: "hangs", description: "x", inputSchema: { type: "object" }, execute: () => new Promise(() => {}) },
          ],
        }),
      };`
    );

    const loaded = await load([{ source }]);
    const controller = new AbortController();

    await expect(
      loaded.execute("faulty:throws", {}, toolContext())
    ).resolves.toStrictEqual({
      content: [{ text: "faulty:throws failed: disk full", type: "text" }],
      isError: true,
    });
    await expect(
      loaded.execute("faulty:garbage", {}, toolContext())
    ).resolves.toMatchObject({ isError: true });
    await expect(
      loaded.execute("faulty:unknown", {}, toolContext())
    ).resolves.toStrictEqual({
      content: [{ text: "Unknown Tool: faulty:unknown", type: "text" }],
      isError: true,
    });

    const hanging = loaded.execute(
      "faulty:hangs",
      {},
      toolContext(controller.signal)
    );

    controller.abort(new Error("Run stopped"));

    await expect(hanging).resolves.toStrictEqual({
      content: [{ text: "faulty:hangs was aborted", type: "text" }],
      isError: true,
    });
  });

  it("disposes every Plugin on close and offers no Tools afterwards", async () => {
    const source = await writeLocalPlugin("notes.mjs", notesPlugin());
    const loaded = await load([{ source }]);

    await loaded.close();
    await loaded.close();

    await expect(
      readFile(path.join(agentDir, "plugins", "notes", "disposed"), "utf-8")
    ).resolves.toBe("yes");
    expect(loaded.health()).toStrictEqual([
      { name: "notes", state: "stopped" },
    ]);
    expect(loaded.tools()).toStrictEqual([]);
    await expect(
      loaded.execute("notes:add", { text: "milk" }, toolContext())
    ).resolves.toMatchObject({ isError: true });
  });

  it("reports Plugins as stopped if the Agent stops while they load", async () => {
    const source = await writeLocalPlugin(
      "waits.mjs",
      `export default {
        apiVersion: 1,
        name: "waits",
        version: "1.0.0",
        setup: (ctx) => new Promise((resolve, reject) => {
          ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason));
        }),
      };`
    );

    const controller = new AbortController();
    const loading = load([{ source }], {}, { signal: controller.signal });

    setTimeout(() => {
      controller.abort(new Error("Agent stopped"));
    }, SHORT_TIMEOUT_MS);

    const loaded = await loading;

    expect(loaded.health()).toStrictEqual([
      {
        error: "The Agent stopped while the Plugin loaded",
        name: "waits",
        state: "stopped",
      },
    ]);
  });
});
