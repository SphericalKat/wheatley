import type { DatabaseSync } from "node:sqlite";

import type { Clock } from "../contracts/module.js";
import {
  MigrationError,
  planMigrations,
  runMigrations,
} from "../db/migrations.js";
import type {
  MigrationErrorCode,
  MigrationNamespace,
  PlannedMigration,
} from "../db/migrations.js";
import { backupAgentDatabase } from "./backup.js";
import type { BackupInfo } from "./backup.js";

export interface AgentMigrationOptions {
  readonly agent: string;
  /** The Agent folder that holds `agent.sqlite` and `backups/`. */
  readonly agentDir: string;
  readonly namespaces: readonly MigrationNamespace[];
  readonly clock: Clock;
  /** How many backups to keep. The default is `DEFAULT_BACKUP_RETENTION`. */
  readonly retain?: number;
}

/** The migrations succeeded. The Agent can create its modules. */
export interface AgentMigrated {
  readonly outcome: "migrated";
  readonly agent: string;
  readonly applied: readonly PlannedMigration[];
  /** The pre-migration backup, or `undefined` if nothing was pending or the database was empty. */
  readonly backup: BackupInfo | undefined;
}

/**
 * The migrations failed or did not start. The Agent must enter the `degraded` state and must not create its modules.
 * `state` and `error` match the `agent.status` event payload.
 */
export interface AgentMigrationDegraded {
  readonly outcome: "degraded";
  readonly agent: string;
  readonly state: "degraded";
  /** A message for `AgentHealth.lastError`. It names the backup to restore, if one exists. */
  readonly error: string;
  /** The `MigrationError` code, or `backup_failed` if the pre-migration backup failed. */
  readonly code: MigrationErrorCode | "backup_failed";
  readonly backup: BackupInfo | undefined;
  readonly cause: Error;
}

export type AgentMigrationReport = AgentMigrated | AgentMigrationDegraded;

const causeMessage = (error: Error): string =>
  error.cause instanceof Error
    ? `${error.message}: ${error.cause.message}`
    : error.message;

const degraded = (
  options: AgentMigrationOptions,
  error: Error,
  backup: BackupInfo | undefined
): AgentMigrationDegraded => {
  const restoreHint =
    backup === undefined
      ? ""
      : `. Restore the pre-migration backup with: wheatley restore ${options.agent} ${backup.file}`;

  return {
    agent: options.agent,
    backup,
    cause: error,
    code: error instanceof MigrationError ? error.code : "backup_failed",
    error: `${causeMessage(error)}${restoreHint}`,
    outcome: "degraded",
    state: "degraded",
  };
};

const isEmpty = (db: DatabaseSync): boolean =>
  db.prepare("SELECT 1 FROM sqlite_schema LIMIT 1").get() === undefined;

/**
 * Backs up `agent.sqlite` with `VACUUM INTO` and then applies the pending migrations of every module.
 *
 * Ordering: plan, back up, migrate. It takes a backup only if a migration is pending and the database is not empty, so
 * a new Agent gets no backup and an up-to-date Agent gets no extra backup on each start.
 *
 * Errors: it never throws for a migration or backup failure. It returns `outcome: "degraded"` instead, so that one
 * Agent's failure cannot stop the Deployment. It does not migrate if the backup fails. If a migration fails, the
 * migrations before it stay applied, and the report names the backup to restore.
 */
export const migrateAgentDatabase = async (
  db: DatabaseSync,
  options: AgentMigrationOptions
): Promise<AgentMigrationReport> => {
  let pending: PlannedMigration[] = [];

  try {
    pending = planMigrations(db, options.namespaces);
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));

    return degraded(options, failure, undefined);
  }

  let backup: BackupInfo | undefined;

  if (pending.length > 0 && !isEmpty(db)) {
    try {
      const result = await backupAgentDatabase(db, {
        agentDir: options.agentDir,
        clock: options.clock,
        reason: "pre-migration",
        retain: options.retain,
      });

      ({ backup } = result);
    } catch (error) {
      return degraded(
        options,
        new Error("Pre-migration backup failed", { cause: error }),
        undefined
      );
    }
  }

  try {
    const applied = runMigrations(
      db,
      options.namespaces,
      () => new Date(options.clock.now())
    );

    return { agent: options.agent, applied, backup, outcome: "migrated" };
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));

    return degraded(options, failure, backup);
  }
};
