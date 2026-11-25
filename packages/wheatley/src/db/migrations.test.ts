import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openAgentDatabase } from "./database.js";
import { MigrationError, planMigrations, runMigrations } from "./migrations.js";
import type {
  Migration,
  MigrationNamespace,
  PlannedMigration,
} from "./migrations.js";

const createTable =
  (table: string): Migration["up"] =>
  (db) => {
    db.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, value TEXT)`);
  };

const memory: MigrationNamespace = {
  migrations: [
    { name: "create files", up: createTable("memory_files"), version: 1 },
    {
      name: "add archive",
      up: createTable("memory_archive"),
      version: 2,
    },
  ],
  namespace: "memory",
};

const triggers: MigrationNamespace = {
  migrations: [
    { name: "create triggers", up: createTable("triggers_rules"), version: 1 },
  ],
  namespace: "triggers",
};

const tableNames = (db: DatabaseSync): string[] =>
  db
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name"
    )
    .all()
    .map((row) => String(row.name));

/** Runs `run` and returns the `MigrationError` that it throws. */
const catchMigrationError = (run: () => PlannedMigration[]): MigrationError => {
  try {
    run();
  } catch (error) {
    if (error instanceof MigrationError) {
      return error;
    }

    throw error;
  }

  throw new Error("Expected a MigrationError");
};

let dir = "";
let db: DatabaseSync;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "wheatley-migrations-"));
  db = openAgentDatabase(path.join(dir, "agent.sqlite"));
});

afterEach(async () => {
  db.close();
  await rm(dir, { force: true, recursive: true });
});

describe("runMigrations", () => {
  it("applies namespaces in the given order and versions in ascending order", () => {
    const applied = runMigrations(db, [triggers, memory]);

    expect(applied).toStrictEqual([
      { name: "create triggers", namespace: "triggers", version: 1 },
      { name: "create files", namespace: "memory", version: 1 },
      { name: "add archive", namespace: "memory", version: 2 },
    ]);
    expect(tableNames(db)).toStrictEqual([
      "memory_archive",
      "memory_files",
      "triggers_rules",
      "wheatley_migrations",
    ]);
  });

  it("applies nothing on a second run", () => {
    runMigrations(db, [memory, triggers]);

    expect(runMigrations(db, [memory, triggers])).toStrictEqual([]);
  });

  it("applies only a migration that a later release adds", () => {
    runMigrations(db, [
      { ...memory, migrations: memory.migrations.slice(0, 1) },
    ]);

    expect(runMigrations(db, [memory])).toStrictEqual([
      { name: "add archive", namespace: "memory", version: 2 },
    ]);
  });

  it("keeps the same version numbers apart in different namespaces", () => {
    runMigrations(db, [memory]);

    expect(planMigrations(db, [memory, triggers])).toStrictEqual([
      { name: "create triggers", namespace: "triggers", version: 1 },
    ]);
  });

  it("rolls back a failed migration and keeps earlier ones", () => {
    const failing: MigrationNamespace = {
      migrations: [
        memory.migrations[0] ?? { name: "missing", up: () => {}, version: 1 },
        {
          name: "half done",
          up: (handle) => {
            handle.exec("CREATE TABLE memory_partial (id INTEGER)");
            throw new Error("disk full");
          },
          version: 2,
        },
      ],
      namespace: "memory",
    };

    expect(catchMigrationError(() => runMigrations(db, [failing])).code).toBe(
      "migration_failed"
    );
    expect(tableNames(db)).toStrictEqual([
      "memory_files",
      "wheatley_migrations",
    ]);
    expect(planMigrations(db, [memory])).toStrictEqual([
      { name: "add archive", namespace: "memory", version: 2 },
    ]);
  });

  it("reports the original error as the cause of a failed migration", () => {
    const failing: MigrationNamespace = {
      migrations: [
        {
          name: "bad sql",
          up: (handle) => {
            handle.exec("CREATE TABLE (");
          },
          version: 1,
        },
      ],
      namespace: "memory",
    };

    const error = catchMigrationError(() => runMigrations(db, [failing]));

    expect(error).toMatchObject({
      code: "migration_failed",
      namespace: "memory",
      version: 1,
    });
    expect(error.cause).toBeInstanceOf(Error);
  });

  it("fails a migration that ends the runner's transaction", () => {
    const committing: MigrationNamespace = {
      migrations: [
        {
          name: "commits itself",
          up: (handle) => {
            handle.exec("COMMIT");
          },
          version: 1,
        },
      ],
      namespace: "memory",
    };

    expect(
      catchMigrationError(() => runMigrations(db, [committing])).code
    ).toBe("migration_failed");
  });
});

describe("planMigrations", () => {
  it("lists pending migrations without writing", () => {
    expect(planMigrations(db, [memory])).toHaveLength(2);
    expect(tableNames(db)).toStrictEqual([]);
  });

  it("refuses a database with a version that this release does not declare", () => {
    runMigrations(db, [memory]);

    expect(
      catchMigrationError(() =>
        planMigrations(db, [
          { ...memory, migrations: memory.migrations.slice(0, 1) },
        ])
      ).code
    ).toBe("newer_schema");
  });

  it("refuses a database with a namespace that this release does not declare", () => {
    runMigrations(db, [memory, triggers]);

    expect(catchMigrationError(() => planMigrations(db, [memory])).code).toBe(
      "newer_schema"
    );
  });

  it("refuses a stored migration whose name changed", () => {
    runMigrations(db, [triggers]);

    const renamed: MigrationNamespace = {
      migrations: [
        { name: "renamed", up: createTable("triggers_rules"), version: 1 },
      ],
      namespace: "triggers",
    };

    expect(catchMigrationError(() => planMigrations(db, [renamed])).code).toBe(
      "history_mismatch"
    );
  });

  it.each([
    ["an invalid namespace", [{ migrations: [], namespace: "Memory" }]],
    ["a duplicate namespace", [memory, memory]],
    [
      "a version gap",
      [
        {
          migrations: [{ name: "two", up: createTable("x_two"), version: 2 }],
          namespace: "x",
        },
      ],
    ],
  ])("rejects %s", (_label, namespaces: readonly MigrationNamespace[]) => {
    expect(catchMigrationError(() => planMigrations(db, namespaces)).code).toBe(
      "invalid_definition"
    );
  });
});
