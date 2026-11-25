import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Clock } from "../contracts/module.js";
import { openAgentDatabase } from "../db/database.js";
import type { Migration, MigrationNamespace } from "../db/migrations.js";
import { listBackups, restoreAgentBackup } from "./backup.js";
import { migrateAgentDatabase } from "./migrate.js";

const clock: Clock = { now: () => Date.parse("2026-11-26T09:30:00.000Z") };

const createItems: Migration = {
  name: "create items",
  up: (db) => {
    db.exec("CREATE TABLE notes_items (id INTEGER PRIMARY KEY, body TEXT)");
  },
  version: 1,
};

const addTags: Migration = {
  name: "add tags",
  up: (db) => {
    db.exec("ALTER TABLE notes_items ADD COLUMN tags TEXT");
  },
  version: 2,
};

const broken: Migration = {
  name: "broken",
  up: (db) => {
    db.exec("ALTER TABLE notes_items ADD COLUMN extra TEXT");
    throw new Error("disk full");
  },
  version: 2,
};

const notes = (...migrations: Migration[]): MigrationNamespace => ({
  migrations,
  namespace: "notes",
});

let agentDir = "";
let db: DatabaseSync;

beforeEach(async () => {
  agentDir = await mkdtemp(path.join(tmpdir(), "wheatley-migrate-"));
  db = openAgentDatabase(path.join(agentDir, "agent.sqlite"));
});

afterEach(async () => {
  if (db.isOpen) {
    db.close();
  }

  await rm(agentDir, { force: true, recursive: true });
});

const migrate = async (namespace: MigrationNamespace) =>
  await migrateAgentDatabase(db, {
    agent: "home",
    agentDir,
    clock,
    namespaces: [namespace],
  });

describe("pre-migration backups", () => {
  it("skips the backup for a new, empty database", async () => {
    const report = await migrate(notes(createItems));

    expect(report).toMatchObject({ backup: undefined, outcome: "migrated" });
    expect(report.outcome === "migrated" && report.applied).toHaveLength(1);
    await expect(listBackups(agentDir)).resolves.toHaveLength(0);
  });

  it("backs up before it applies a pending migration", async () => {
    await migrate(notes(createItems));
    db.prepare("INSERT INTO notes_items (body) VALUES (?)").run("kept");

    const report = await migrate(notes(createItems, addTags));

    expect(report.outcome).toBe("migrated");
    expect(report.backup?.reason).toBe("pre-migration");

    const snapshot = openAgentDatabase(report.backup?.path ?? "");

    try {
      const columns = snapshot
        .prepare("SELECT name FROM pragma_table_info('notes_items')")
        .all()
        .map((row) => String(row.name));

      expect(columns).toStrictEqual(["id", "body"]);
    } finally {
      snapshot.close();
    }
  });

  it("takes no backup when nothing is pending", async () => {
    await migrate(notes(createItems));
    db.prepare("INSERT INTO notes_items (body) VALUES (?)").run("kept");

    const report = await migrate(notes(createItems));

    expect(report).toMatchObject({ backup: undefined, outcome: "migrated" });
    await expect(listBackups(agentDir)).resolves.toHaveLength(0);
  });
});

describe("degraded reports", () => {
  it("reports a failed migration as degraded and names the backup to restore", async () => {
    await migrate(notes(createItems));
    db.prepare("INSERT INTO notes_items (body) VALUES (?)").run("kept");

    const report = await migrate(notes(createItems, broken));

    if (report.outcome !== "degraded") {
      throw new Error("Expected a degraded report");
    }

    expect(report.state).toBe("degraded");
    expect(report.code).toBe("migration_failed");
    expect(report.error).toContain("disk full");
    expect(report.error).toContain(
      `wheatley restore home ${report.backup?.file ?? "?"}`
    );

    db.close();
    await restoreAgentBackup({
      agentDir,
      backup: report.backup?.file ?? "",
      clock,
    });
    db = openAgentDatabase(path.join(agentDir, "agent.sqlite"));

    expect(db.prepare("SELECT body FROM notes_items").get()?.body).toBe("kept");
  });

  it("reports a database from a newer Wheatley version without a backup", async () => {
    await migrate(notes(createItems, addTags));

    const report = await migrate(notes(createItems));

    expect(report).toMatchObject({
      backup: undefined,
      code: "newer_schema",
      outcome: "degraded",
      state: "degraded",
    });
  });

  it("does not migrate if the backup fails", async () => {
    await migrate(notes(createItems));
    db.prepare("INSERT INTO notes_items (body) VALUES (?)").run("kept");
    db.exec("BEGIN");

    const report = await migrate(notes(createItems, addTags));

    db.exec("ROLLBACK");

    expect(report).toMatchObject({
      code: "backup_failed",
      outcome: "degraded",
    });
    expect(report.outcome === "degraded" && report.error).toContain(
      "Pre-migration backup failed"
    );
    expect(
      db.prepare("SELECT count(*) AS n FROM wheatley_migrations").get()?.n
    ).toBe(1);
  });
});
