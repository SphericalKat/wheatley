import { constants } from "node:sqlite";
import type { DatabaseSync } from "node:sqlite";

/** One schema change for `agent.sqlite`. */
export interface Migration {
  /** Starts at 1 and increases by 1 within its namespace. Never renumber a released migration. */
  readonly version: number;
  /** A short description. The runner stores it and refuses to start if a stored name differs. */
  readonly name: string;
  /**
   * Applies the change. The runner calls it inside a transaction that it owns, with foreign key enforcement off, so a
   * migration can rebuild a referenced table (create, copy, drop, rename) without cascades. The runner denies
   * `BEGIN`, `COMMIT`, and `ROLLBACK` while it runs, and SQLite rejects `VACUUM` inside a transaction. A throw rolls
   * back this migration only.
   */
  readonly up: (db: DatabaseSync) => void;
}

/**
 * The migrations of one module. Each Wave 1 module owns one namespace, named after the module, and prefixes its
 * tables with it (for example `memory_files`).
 */
export interface MigrationNamespace {
  /** Matches `^[a-z][a-z0-9_]{0,31}$`. */
  readonly namespace: string;
  readonly migrations: readonly Migration[];
}

/** A migration that the runner applied or will apply. */
export interface PlannedMigration {
  readonly namespace: string;
  readonly version: number;
  readonly name: string;
}

/** Why the runner refused or failed. */
export type MigrationErrorCode =
  /** A namespace or migration list breaks the rules of `MigrationNamespace` or `Migration`. */
  | "invalid_definition"
  /** The database has a migration that this Wheatley version does not know: it comes from a newer version. */
  | "newer_schema"
  /** A stored migration name differs from the declared name of the same version. */
  | "history_mismatch"
  /** A migration threw, tried to end the runner's transaction, or left a foreign key violation. */
  | "migration_failed";

/** The error that `planMigrations` and `runMigrations` throw. */
export class MigrationError extends Error {
  override readonly name = "MigrationError";
  readonly code: MigrationErrorCode;
  readonly namespace: string | undefined;
  readonly version: number | undefined;

  constructor(
    code: MigrationErrorCode,
    message: string,
    location?: { readonly namespace: string; readonly version?: number },
    cause?: unknown
  ) {
    super(message, { cause });
    this.code = code;
    this.namespace = location?.namespace;
    this.version = location?.version;
  }
}

const NAMESPACE = /^[a-z][a-z0-9_]{0,31}$/u;
const LEDGER = "wheatley_migrations";

interface LedgerRow {
  readonly namespace: string;
  readonly version: number;
  readonly name: string;
}

const isLedgerRow = (row: unknown): row is LedgerRow =>
  typeof row === "object" &&
  row !== null &&
  "namespace" in row &&
  typeof row.namespace === "string" &&
  "version" in row &&
  typeof row.version === "number" &&
  "name" in row &&
  typeof row.name === "string";

const validateDefinitions = (
  namespaces: readonly MigrationNamespace[]
): void => {
  const seen = new Set<string>();

  for (const { namespace, migrations } of namespaces) {
    if (!NAMESPACE.test(namespace)) {
      throw new MigrationError(
        "invalid_definition",
        `Invalid migration namespace: ${namespace}`,
        { namespace }
      );
    }

    if (seen.has(namespace)) {
      throw new MigrationError(
        "invalid_definition",
        `Duplicate migration namespace: ${namespace}`,
        { namespace }
      );
    }

    seen.add(namespace);

    for (const [index, migration] of migrations.entries()) {
      if (migration.version !== index + 1) {
        throw new MigrationError(
          "invalid_definition",
          `Migration ${namespace} #${index + 1} has version ${migration.version}; versions must be 1, 2, 3, ...`,
          { namespace, version: migration.version }
        );
      }
    }
  }
};

const ledgerExists = (db: DatabaseSync): boolean =>
  db
    .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?")
    .get(LEDGER) !== undefined;

const readLedger = (db: DatabaseSync): LedgerRow[] => {
  if (!ledgerExists(db)) {
    return [];
  }

  return db
    .prepare(
      `SELECT namespace, version, name FROM ${LEDGER} ORDER BY namespace, version`
    )
    .all()
    .flatMap((row) => (isLedgerRow(row) ? [row] : []));
};

const pendingFor = (
  namespace: MigrationNamespace,
  applied: readonly LedgerRow[]
): PlannedMigration[] => {
  const declared = namespace.migrations;
  const appliedVersions = new Set<number>();

  for (const row of applied) {
    const migration = declared[row.version - 1];

    if (migration === undefined) {
      throw new MigrationError(
        "newer_schema",
        `Database has migration ${row.namespace} v${row.version}, which this Wheatley version does not know`,
        { namespace: row.namespace, version: row.version }
      );
    }

    if (migration.name !== row.name) {
      throw new MigrationError(
        "history_mismatch",
        `Migration ${row.namespace} v${row.version} is stored as "${row.name}" but declared as "${migration.name}"`,
        { namespace: row.namespace, version: row.version }
      );
    }

    appliedVersions.add(row.version);
  }

  return declared
    .filter((migration) => !appliedVersions.has(migration.version))
    .map(({ name, version }) => ({
      name,
      namespace: namespace.namespace,
      version,
    }));
};

/**
 * Lists the migrations that `runMigrations` would apply, in order, without writing to the database.
 *
 * Use it to decide whether a pre-migration backup is needed. Throws a `MigrationError`:
 * - `invalid_definition` for broken definitions;
 * - `newer_schema` if the database has a migration that no definition declares, for example in a namespace of a newer
 *   Wheatley version or past the last declared version;
 * - `history_mismatch` if a stored migration name differs from its declaration.
 */
export const planMigrations = (
  db: DatabaseSync,
  namespaces: readonly MigrationNamespace[]
): PlannedMigration[] => {
  validateDefinitions(namespaces);

  const applied = readLedger(db);

  const declaredNamespaces = new Set(
    namespaces.map(({ namespace }) => namespace)
  );

  const unknown = applied.find((row) => !declaredNamespaces.has(row.namespace));

  if (unknown !== undefined) {
    throw new MigrationError(
      "newer_schema",
      `Database has migrations in namespace ${unknown.namespace}, which this Wheatley version does not know`,
      { namespace: unknown.namespace, version: unknown.version }
    );
  }

  return namespaces.flatMap((namespace) =>
    pendingFor(
      namespace,
      applied.filter((row) => row.namespace === namespace.namespace)
    )
  );
};

const isApplied = (db: DatabaseSync, planned: PlannedMigration): boolean =>
  db
    .prepare(`SELECT 1 FROM ${LEDGER} WHERE namespace = ? AND version = ?`)
    .get(planned.namespace, planned.version) !== undefined;

const foreignKeysOn = (db: DatabaseSync): boolean =>
  db.prepare("PRAGMA foreign_keys").get()?.foreign_keys === 1;

/** Denies statements that end the runner's transaction, so a migration cannot commit half of its work. */
const denyTransactionControl = (actionCode: number): number =>
  actionCode === constants.SQLITE_TRANSACTION
    ? constants.SQLITE_DENY
    : constants.SQLITE_OK;

const runInTransaction = (
  db: DatabaseSync,
  migration: Migration,
  planned: PlannedMigration,
  appliedAt: string
): boolean => {
  db.exec("BEGIN IMMEDIATE");

  try {
    // Another connection can apply the migration between the plan and this lock.
    if (isApplied(db, planned)) {
      db.exec("ROLLBACK");

      return false;
    }

    db.setAuthorizer(denyTransactionControl);

    try {
      migration.up(db);
    } finally {
      db.setAuthorizer(null);
    }

    const violations = db.prepare("PRAGMA foreign_key_check").all();

    if (violations.length > 0) {
      throw new Error(
        `The migration left ${violations.length} foreign key violations`
      );
    }

    db.prepare(
      `INSERT INTO ${LEDGER} (namespace, version, name, applied_at) VALUES (?, ?, ?, ?)`
    ).run(planned.namespace, planned.version, planned.name, appliedAt);
    db.exec("COMMIT");

    return true;
  } catch (error) {
    if (db.isTransaction) {
      db.exec("ROLLBACK");
    }

    throw new MigrationError(
      "migration_failed",
      `Migration ${planned.namespace} v${planned.version} (${planned.name}) failed`,
      { namespace: planned.namespace, version: planned.version },
      error
    );
  }
};

/**
 * Applies one migration with foreign key enforcement off. SQLite ignores `PRAGMA foreign_keys` inside a transaction,
 * so the runner switches it before `BEGIN` and restores it afterward. Resolves `false` if the migration was already
 * applied.
 */
const applyOne = (
  db: DatabaseSync,
  migration: Migration,
  planned: PlannedMigration,
  appliedAt: string
): boolean => {
  const restoreForeignKeys = foreignKeysOn(db);
  db.exec("PRAGMA foreign_keys = OFF");

  try {
    return runInTransaction(db, migration, planned, appliedAt);
  } finally {
    if (restoreForeignKeys) {
      db.exec("PRAGMA foreign_keys = ON");
    }
  }
};

/**
 * Applies every pending migration and returns the applied ones, in order.
 *
 * Order: namespaces in the given order, versions ascending within a namespace. Each migration runs in its own
 * `BEGIN IMMEDIATE` transaction together with its ledger row in `wheatley_migrations`, so a failed migration leaves
 * the database at the previous migration. Before it commits, the runner runs `PRAGMA foreign_key_check` and fails the
 * migration on any violation. A migration that another connection applied after the plan is skipped and not returned.
 * A second call applies nothing. Throws the errors of `planMigrations`, and `migration_failed` with the original error
 * as `cause` if a migration fails; migrations before it stay applied.
 */
export const runMigrations = (
  db: DatabaseSync,
  namespaces: readonly MigrationNamespace[],
  now: () => Date = () => new Date()
): PlannedMigration[] => {
  const pending = planMigrations(db, namespaces);

  db.exec(
    `CREATE TABLE IF NOT EXISTS ${LEDGER} (
      namespace TEXT NOT NULL,
      version INTEGER NOT NULL,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL,
      PRIMARY KEY (namespace, version)
    ) STRICT`
  );

  const byNamespace = new Map(
    namespaces.map((namespace) => [namespace.namespace, namespace.migrations])
  );

  const applied: PlannedMigration[] = [];

  for (const planned of pending) {
    const migration = byNamespace.get(planned.namespace)?.[planned.version - 1];

    if (migration === undefined) {
      throw new MigrationError(
        "invalid_definition",
        `Migration ${planned.namespace} v${planned.version} vanished`,
        {
          namespace: planned.namespace,
          version: planned.version,
        }
      );
    }

    if (applyOne(db, migration, planned, now().toISOString())) {
      applied.push(planned);
    }
  }

  return applied;
};
