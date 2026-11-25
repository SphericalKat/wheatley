import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, it } from "vitest";

import { migrationNamespace, systemClock } from "../contracts/module.js";
import type { AgentModuleContext } from "../contracts/module.js";
import { InMemorySecretStore } from "../contracts/secret-store.fake.js";
import { openAgentDatabase } from "../db/database.js";
import { runMigrations } from "../db/migrations.js";
import { pluginsModule } from "./module.js";

let homeDir = "";

beforeEach(async () => {
  homeDir = await mkdtemp(path.join(tmpdir(), "wheatley-plugins-module-"));
});

afterEach(async () => {
  await rm(homeDir, { force: true, recursive: true });
});

it("starts an Agent module with a broken Plugin and serves the Tools of the working one", async () => {
  await mkdir(path.join(homeDir, "plugins"));
  await writeFile(
    path.join(homeDir, "plugins", "broken.mjs"),
    'throw new Error("syntax of the future");'
  );
  await writeFile(
    path.join(homeDir, "plugins", "clock.mjs"),
    `export default {
      apiVersion: 1,
      name: "clock",
      version: "1.0.0",
      setup: () => ({
        tools: [{ name: "now", description: "Tells the time", inputSchema: { type: "object" }, execute: async () => ({ content: [{ type: "text", text: "noon" }] }) }],
      }),
    };`
  );

  const db = openAgentDatabase(":memory:");

  try {
    runMigrations(db, [migrationNamespace(pluginsModule)]);

    const ctx: AgentModuleContext = {
      agentDir: path.join(homeDir, "agents", "home"),
      agentName: "home",
      clock: systemClock,
      db,
      events: { emit: () => {} },
      log: { debug: () => {}, error: () => {}, info: () => {}, warn: () => {} },
    };

    const instance = await pluginsModule.create(ctx, {
      config: {
        model: { id: "model-1", provider: "test" },
        plugins: [
          { source: "./plugins/broken.mjs" },
          { source: "./plugins/clock.mjs" },
        ],
      },
      homeDir,
      secrets: new InMemorySecretStore(),
      signal: new AbortController().signal,
    });

    await instance.start?.();

    expect(instance.api.health()).toStrictEqual([
      {
        error: "syntax of the future",
        name: "./plugins/broken.mjs",
        state: "failed",
      },
      { name: "clock", state: "ready" },
    ]);
    expect(instance.api.tools().map((tool) => tool.name)).toStrictEqual([
      "clock:now",
    ]);

    await instance.stop?.();

    expect(instance.api.health()[1]).toStrictEqual({
      name: "clock",
      state: "stopped",
    });
  } finally {
    db.close();
  }
});
