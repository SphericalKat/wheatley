import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Clock } from "../contracts/module.js";
import { openAgentDatabase } from "../db/database.js";
import { runMigrations } from "../db/migrations.js";
import type { MigrationNamespace } from "../db/migrations.js";
import {
  backupAgentDatabase,
  listBackups,
  restoreAgentBackup,
} from "./backup.js";

const notes: MigrationNamespace = {
  migrations: [
    {
      name: "create items",
      up: (db) => {
        db.exec("CREATE TABLE notes_items (id INTEGER PRIMARY KEY, body TEXT)");
      },
      version: 1,
    },
  ],
  namespace: "notes",
};

const START = Date.parse("2026-11-26T09:30:00.000Z");
const MINUTE = 60_000;

const steppingClock = (): Clock => {
  let tick = 0;

  return {
    now: () => {
      tick += 1;

      return START + tick * MINUTE;
    },
  };
};

const bodies = (db: DatabaseSync): string[] =>
  db
    .prepare("SELECT body FROM notes_items ORDER BY id")
    .all()
    .map((row) => String(row.body));

let agentDir = "";

beforeEach(async () => {
  agentDir = await mkdtemp(path.join(tmpdir(), "wheatley-backup-"));
});

afterEach(async () => {
  await rm(agentDir, { force: true, recursive: true });
});

const openAgent = (): DatabaseSync => {
  const db = openAgentDatabase(path.join(agentDir, "agent.sqlite"));
  runMigrations(db, [notes]);

  return db;
};

describe("VACUUM INTO backups", () => {
  it("writes an owner-only snapshot that restores the data", async () => {
    const db = openAgent();
    const clock = steppingClock();

    try {
      db.prepare("INSERT INTO notes_items (body) VALUES (?)").run("before");

      const { backup } = await backupAgentDatabase(db, {
        agentDir,
        clock,
        reason: "pre-migration",
      });

      expect(backup.file).toBe(
        "agent-20261126T093100000Z-pre-migration.sqlite"
      );
      expect(backup.createdAt).toBe("2026-11-26T09:31:00.000Z");
      const info = await stat(backup.path);

      expect(info.mode.toString(8).slice(-3)).toBe("600");

      db.prepare("INSERT INTO notes_items (body) VALUES (?)").run("after");
    } finally {
      db.close();
    }

    const [backup] = await listBackups(agentDir);

    const result = await restoreAgentBackup({
      agentDir,
      backup: backup?.file ?? "",
      clock: steppingClock(),
    });

    expect(result.restoredFrom).toBe(backup?.path);
    expect(result.safetyBackup?.reason).toBe("pre-restore");

    const restored = openAgentDatabase(path.join(agentDir, "agent.sqlite"));

    try {
      expect(bodies(restored)).toStrictEqual(["before"]);
    } finally {
      restored.close();
    }

    const safety = openAgentDatabase(result.safetyBackup?.path ?? "");

    try {
      expect(bodies(safety)).toStrictEqual(["before", "after"]);
    } finally {
      safety.close();
    }
  });

  it("keeps the 5 newest backups per Agent", async () => {
    const db = openAgent();
    const clock = steppingClock();
    const created: string[] = [];

    try {
      for (let index = 0; index < 7; index += 1) {
        // Each backup depends on the rotation of the one before it.
        // oxlint-disable-next-line no-await-in-loop
        const { backup } = await backupAgentDatabase(db, {
          agentDir,
          clock,
          reason: "pre-migration",
        });

        created.push(backup.file);
      }
    } finally {
      db.close();
    }

    const kept = await listBackups(agentDir);

    expect(kept.map(({ file }) => file)).toStrictEqual(
      created.slice(2).toReversed()
    );
    await expect(readdir(path.join(agentDir, "backups"))).resolves.toHaveLength(
      5
    );
  });

  it("gives two backups in the same millisecond distinct names", async () => {
    const db = openAgent();
    const clock: Clock = { now: () => START };

    try {
      const first = await backupAgentDatabase(db, {
        agentDir,
        clock,
        reason: "pre-migration",
      });

      const second = await backupAgentDatabase(db, {
        agentDir,
        clock,
        reason: "pre-migration",
      });

      expect(second.backup.file).not.toBe(first.backup.file);
      const [newest] = await listBackups(agentDir);

      expect(newest?.file).toBe(second.backup.file);
    } finally {
      db.close();
    }
  });

  it("refuses to back up inside a transaction", async () => {
    const db = openAgent();

    try {
      db.exec("BEGIN");

      await expect(
        backupAgentDatabase(db, {
          agentDir,
          clock: steppingClock(),
          reason: "pre-migration",
        })
      ).rejects.toThrow("transaction");
      db.exec("ROLLBACK");
    } finally {
      db.close();
    }
  });
});

describe("restore", () => {
  it("restores the oldest backup although the pre-restore backup rotates it out", async () => {
    const db = openAgent();
    const clock = steppingClock();
    const files: string[] = [];

    try {
      for (let index = 0; index < 5; index += 1) {
        db.prepare("INSERT INTO notes_items (body) VALUES (?)").run(
          `v${index}`
        );

        // Each backup must see the row inserted just before it.
        // oxlint-disable-next-line no-await-in-loop
        const { backup } = await backupAgentDatabase(db, {
          agentDir,
          clock,
          reason: "pre-migration",
        });

        files.push(backup.file);
      }
    } finally {
      db.close();
    }

    await restoreAgentBackup({ agentDir, backup: files[0] ?? "", clock });

    const restored = openAgentDatabase(path.join(agentDir, "agent.sqlite"));

    try {
      expect(bodies(restored)).toStrictEqual(["v0"]);
    } finally {
      restored.close();
    }

    const kept = await listBackups(agentDir);

    expect(kept).toHaveLength(5);
    expect(kept.map(({ file }) => file)).not.toContain(files[0]);
  });

  it("rejects a file that is not a Wheatley backup and keeps agent.sqlite", async () => {
    const db = openAgent();
    db.prepare("INSERT INTO notes_items (body) VALUES (?)").run("current");
    db.close();

    const foreign = openAgentDatabase(path.join(agentDir, "other.sqlite"));
    foreign.exec("CREATE TABLE t (x)");
    foreign.close();

    await expect(
      restoreAgentBackup({
        agentDir,
        backup: path.join(agentDir, "other.sqlite"),
        clock: steppingClock(),
      })
    ).rejects.toThrow("not a Wheatley agent.sqlite backup");

    const current = openAgentDatabase(path.join(agentDir, "agent.sqlite"));

    try {
      expect(bodies(current)).toStrictEqual(["current"]);
    } finally {
      current.close();
    }

    expect(await readdir(agentDir)).not.toContain("agent.sqlite.restore");
  });

  it("reports a missing backup and a missing Agent folder", async () => {
    await mkdir(path.join(agentDir, "backups"));

    await expect(
      restoreAgentBackup({
        agentDir,
        backup: "nope.sqlite",
        clock: steppingClock(),
      })
    ).rejects.toThrow("Backup not found");
    await expect(
      restoreAgentBackup({
        agentDir: path.join(agentDir, "missing"),
        backup: "nope.sqlite",
        clock: steppingClock(),
      })
    ).rejects.toThrow("Agent folder not found");
  });
});
