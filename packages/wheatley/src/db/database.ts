import { DatabaseSync } from "node:sqlite";

/** How long a statement waits for a lock held by another connection, for example a backup. */
const BUSY_TIMEOUT_MS = 5000;

/**
 * Opens `agent.sqlite` (or `:memory:` in tests) with the settings every Wheatley module relies on: WAL journal,
 * `synchronous = NORMAL`, foreign keys on, and a busy timeout.
 *
 * Only the daemon opens Agent databases (single writer). The caller closes the handle.
 */
export const openAgentDatabase = (path: string): DatabaseSync => {
  const db = new DatabaseSync(path, { timeout: BUSY_TIMEOUT_MS });

  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");

  return db;
};
