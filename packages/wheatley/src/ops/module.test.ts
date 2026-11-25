import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { JsonObject } from "@wheatley/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openAgentDatabase } from "../db/database.js";
import type { MigrationNamespace } from "../db/migrations.js";
import { bundleDashboardAssets } from "./dashboard-assets.js";
import { opsModule } from "./module.js";

interface LogEntry {
  readonly level: string;
  readonly message: string;
  readonly fields: JsonObject | undefined;
}

const notes = (fail: boolean): MigrationNamespace => ({
  migrations: [
    {
      name: "create items",
      up: (db) => {
        db.exec("CREATE TABLE notes_items (id INTEGER PRIMARY KEY)");
      },
      version: 1,
    },
    {
      name: "add body",
      up: (db) => {
        if (fail) {
          throw new Error("bad migration");
        }

        db.exec("ALTER TABLE notes_items ADD COLUMN body TEXT");
      },
      version: 2,
    },
  ],
  namespace: "notes",
});

let home = "";

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "wheatley-ops-"));
});

afterEach(async () => {
  await rm(home, { force: true, recursive: true });
});

const createOps = async (logs: LogEntry[]) => {
  const record =
    (level: string) =>
    (message: string, fields?: JsonObject): void => {
      logs.push({ fields, level, message });
    };

  return await opsModule.create(
    {
      clock: { now: () => Date.parse("2026-11-26T09:30:00.000Z") },
      events: { emit: () => {} },
      homeDir: home,
      log: {
        debug: record("debug"),
        error: record("error"),
        info: record("info"),
        warn: record("warn"),
      },
    },
    {}
  );
};

describe("ops module", () => {
  it("backs up, migrates, and logs a degraded Agent", async () => {
    const logs: LogEntry[] = [];
    const ops = await createOps(logs);
    const agentDir = path.join(home, "agents", "home");
    await mkdir(agentDir, { recursive: true });

    const db = openAgentDatabase(path.join(agentDir, "agent.sqlite"));

    try {
      const first = await ops.api.migrateAgent("home", db, [
        { ...notes(false), migrations: notes(false).migrations.slice(0, 1) },
      ]);

      expect(first.outcome).toBe("migrated");

      const report = await ops.api.migrateAgent("home", db, [notes(true)]);

      expect(report).toMatchObject({ outcome: "degraded", state: "degraded" });
      expect(logs.at(-1)).toMatchObject({
        fields: { agent: "home", code: "migration_failed" },
        level: "error",
        message: "Agent migration failed",
      });
      await expect(ops.api.listBackups("home")).resolves.toHaveLength(1);
    } finally {
      db.close();
    }
  });
});

describe("dashboard assets", () => {
  it("copies the dashboard build and replaces stale files", async () => {
    const source = path.join(home, "dashboard-dist");
    const target = path.join(home, "dist", "dashboard");
    await mkdir(path.join(source, "assets"), { recursive: true });
    await writeFile(path.join(source, "index.html"), "<!doctype html>");
    await writeFile(path.join(source, "assets", "app.js"), "export {};");
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "stale.js"), "");

    await expect(bundleDashboardAssets(source, target)).resolves.toBe(2);
  });

  it("fails without a dashboard build", async () => {
    await expect(
      bundleDashboardAssets(path.join(home, "missing"), path.join(home, "out"))
    ).rejects.toThrow("No dashboard build");
  });
});
