import { chmod, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { Clock } from "../contracts/module.js";
import { openAgentDatabase } from "../db/database.js";
import { AGENT_DATABASE_FILE, BACKUPS_DIR } from "./paths.js";

/** How many backups `backupAgentDatabase` keeps per Agent, newest first. */
export const DEFAULT_BACKUP_RETENTION = 5;

/** Why Wheatley took a backup. */
export type BackupReason = "pre-migration" | "pre-restore";

/** One `VACUUM INTO` backup of `agent.sqlite`. */
export interface BackupInfo {
  /** The file name inside `<agentDir>/backups/`, which `wheatley restore` accepts. */
  readonly file: string;
  readonly path: string;
  /** ISO 8601 UTC time of the backup. */
  readonly createdAt: string;
  readonly reason: BackupReason;
}

export interface BackupOptions {
  /** The Agent folder that holds `agent.sqlite` and `backups/`. */
  readonly agentDir: string;
  readonly reason: BackupReason;
  readonly clock: Clock;
  /** How many backups to keep. The default is `DEFAULT_BACKUP_RETENTION`. */
  readonly retain?: number;
}

export interface BackupResult {
  readonly backup: BackupInfo;
  /** Older backups that rotation deleted. */
  readonly removed: readonly BackupInfo[];
}

const BACKUP_FILE =
  /^agent-(?<stamp>\d{8}T\d{9}Z)-(?<reason>pre-migration|pre-restore)(?:-(?<seq>\d+))?\.sqlite$/u;

const STAMP_SEPARATORS = /[-:.]/gu;

const STAMP_PARTS =
  /^(?<year>\d{4})(?<month>\d{2})(?<day>\d{2})T(?<hour>\d{2})(?<minute>\d{2})(?<second>\d{2})(?<ms>\d{3})Z$/u;

const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const LEDGER = "wheatley_migrations";

const isBackupReason = (value: string): value is BackupReason =>
  value === "pre-migration" || value === "pre-restore";

const stampToIso = (stamp: string): string => {
  const parts = STAMP_PARTS.exec(stamp)?.groups;

  if (parts === undefined) {
    throw new Error(`Invalid backup timestamp: ${stamp}`);
  }

  const { year, month, day, hour, minute, second, ms } = parts;

  return `${year}-${month}-${day}T${hour}:${minute}:${second}.${ms}Z`;
};

interface ParsedBackup {
  readonly info: BackupInfo;
  readonly stamp: string;
  readonly seq: number;
}

const parseBackup = (dir: string, file: string): ParsedBackup | undefined => {
  const groups = BACKUP_FILE.exec(file)?.groups;
  const stamp = groups?.stamp;
  const reason = groups?.reason ?? "";

  if (stamp === undefined || !isBackupReason(reason)) {
    return undefined;
  }

  return {
    info: {
      createdAt: stampToIso(stamp),
      file,
      path: path.join(dir, file),
      reason,
    },
    seq: Number(groups?.seq ?? "0"),
    stamp,
  };
};

const isMissing = (error: Error): boolean =>
  "code" in error && error.code === "ENOENT";

const exists = async (target: string): Promise<boolean> => {
  try {
    await stat(target);

    return true;
  } catch (error) {
    if (error instanceof Error && isMissing(error)) {
      return false;
    }

    throw error;
  }
};

const newestFirst = (a: ParsedBackup, b: ParsedBackup): number =>
  b.stamp.localeCompare(a.stamp) || b.seq - a.seq;

/** Lists the backups of one Agent, newest first. Returns an empty list if the Agent has no `backups/` folder. */
export const listBackups = async (agentDir: string): Promise<BackupInfo[]> => {
  const dir = path.join(agentDir, BACKUPS_DIR);
  let files: string[] = [];

  try {
    files = await readdir(dir);
  } catch (error) {
    if (error instanceof Error && isMissing(error)) {
      return [];
    }

    throw error;
  }

  return files
    .flatMap((file) => parseBackup(dir, file) ?? [])
    .toSorted(newestFirst)
    .map(({ info }) => info);
};

/** Picks a new file name. Two backups in the same millisecond get a sequence suffix. */
const nextBackupPath = async (
  dir: string,
  stamp: string,
  reason: BackupReason
): Promise<string> => {
  const taken = new Set(await readdir(dir));
  let seq = 0;
  let file = `agent-${stamp}-${reason}.sqlite`;

  while (taken.has(file)) {
    seq += 1;
    file = `agent-${stamp}-${reason}-${seq}.sqlite`;
  }

  return path.join(dir, file);
};

const rotate = async (
  agentDir: string,
  retain: number
): Promise<BackupInfo[]> => {
  const backups = await listBackups(agentDir);
  const stale = backups.slice(retain);

  await Promise.all(
    stale.map(async (backup) => {
      await rm(backup.path, { force: true });
    })
  );

  return stale;
};

/**
 * Writes a consistent snapshot of the open `agent.sqlite` handle to `<agentDir>/backups/` with `VACUUM INTO`, then
 * deletes the oldest backups so that `retain` remain.
 *
 * Invariants: backup files are owner-only (`0600`) in an owner-only folder. File names sort by time, so rotation
 * always keeps the newest backups, including the new one.
 *
 * Errors: throws if `db` is inside a transaction (SQLite rejects `VACUUM` there), if `retain` is less than 1, or for
 * I/O errors. A failed `VACUUM INTO` leaves the existing backups unchanged.
 */
export const backupAgentDatabase = async (
  db: DatabaseSync,
  options: BackupOptions
): Promise<BackupResult> => {
  const retain = options.retain ?? DEFAULT_BACKUP_RETENTION;

  if (!Number.isInteger(retain) || retain < 1) {
    throw new RangeError(`Backup retention must be at least 1, got ${retain}`);
  }

  if (db.isTransaction) {
    throw new Error("Cannot back up a database inside an open transaction");
  }

  const dir = path.join(options.agentDir, BACKUPS_DIR);
  await mkdir(dir, { mode: PRIVATE_DIR_MODE, recursive: true });

  const stamp = new Date(options.clock.now())
    .toISOString()
    .replaceAll(STAMP_SEPARATORS, "");

  const target = await nextBackupPath(dir, stamp, options.reason);

  db.prepare("VACUUM INTO ?").run(target);
  await chmod(target, PRIVATE_FILE_MODE);

  const backup = parseBackup(dir, path.basename(target))?.info;

  if (backup === undefined) {
    throw new Error(`Backup file name does not parse: ${target}`);
  }

  return { backup, removed: await rotate(options.agentDir, retain) };
};

const resolveBackupPath = async (
  agentDir: string,
  backup: string
): Promise<string> => {
  const isBareName = path.basename(backup) === backup;

  const candidate = isBareName
    ? path.join(agentDir, BACKUPS_DIR, backup)
    : path.resolve(backup);

  if (!(await exists(candidate))) {
    throw new Error(`Backup not found: ${candidate}`);
  }

  return candidate;
};

const assertRestorable = (source: DatabaseSync, file: string): void => {
  const integrity = source.prepare("PRAGMA integrity_check").all();

  const isIntact =
    integrity.length === 1 && integrity[0]?.integrity_check === "ok";

  if (!isIntact) {
    throw new Error(`Backup fails the SQLite integrity check: ${file}`);
  }

  const hasLedger =
    source
      .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?")
      .get(LEDGER) !== undefined;

  if (!hasLedger) {
    throw new Error(`File is not a Wheatley agent.sqlite backup: ${file}`);
  }
};

const stageBackup = (source: string, staging: string): void => {
  const db = new DatabaseSync(source, { readOnly: true });

  try {
    assertRestorable(db, source);
    db.prepare("VACUUM INTO ?").run(staging);
  } finally {
    db.close();
  }
};

export interface RestoreOptions {
  /** The Agent folder that holds `agent.sqlite` and `backups/`. */
  readonly agentDir: string;
  /** A file name in `<agentDir>/backups/`, or a path to a backup file. */
  readonly backup: string;
  readonly clock: Clock;
  /** How many backups to keep after the pre-restore backup. The default is `DEFAULT_BACKUP_RETENTION`. */
  readonly retain?: number;
}

export interface RestoreResult {
  /** The absolute path of the restored backup. */
  readonly restoredFrom: string;
  /** The backup of the replaced `agent.sqlite`, or `undefined` if the Agent had no `agent.sqlite`. */
  readonly safetyBackup: BackupInfo | undefined;
}

/**
 * Replaces `<agentDir>/agent.sqlite` with a backup.
 *
 * Ordering: it first copies the backup to a staging file, so that rotation cannot delete the source. It then backs up
 * the current `agent.sqlite` (reason `pre-restore`), removes its `-wal` and `-shm` files, and renames the staging file
 * over it. The rename is atomic, so a failure leaves the current `agent.sqlite` in place.
 *
 * Invariant: no other process may have `agent.sqlite` open. The caller must stop the daemon first.
 *
 * Errors: throws if the Agent folder or the backup does not exist, or if the backup fails `PRAGMA integrity_check` or
 * has no `wheatley_migrations` table.
 */
export const restoreAgentBackup = async (
  options: RestoreOptions
): Promise<RestoreResult> => {
  if (!(await exists(options.agentDir))) {
    throw new Error(`Agent folder not found: ${options.agentDir}`);
  }

  const source = await resolveBackupPath(options.agentDir, options.backup);
  const target = path.join(options.agentDir, AGENT_DATABASE_FILE);
  const staging = `${target}.restore`;

  await rm(staging, { force: true });

  try {
    stageBackup(source, staging);
    await chmod(staging, PRIVATE_FILE_MODE);

    let safetyBackup: BackupInfo | undefined;

    if (await exists(target)) {
      const current = openAgentDatabase(target);

      try {
        const result = await backupAgentDatabase(current, {
          agentDir: options.agentDir,
          clock: options.clock,
          reason: "pre-restore",
          retain: options.retain,
        });

        safetyBackup = result.backup;
      } finally {
        current.close();
      }
    }

    await rm(`${target}-wal`, { force: true });
    await rm(`${target}-shm`, { force: true });
    await rename(staging, target);

    return { restoredFrom: source, safetyBackup };
  } finally {
    await rm(staging, { force: true });
  }
};
