import type { DatabaseSync } from "node:sqlite";

import type { MemorySnapshot, MemoryStore } from "../contracts/memory-store.js";
import type { Clock } from "../contracts/module.js";
import { rowOf } from "./rows.js";

const SNAPSHOT_ROW = { text: "text", truncated: "number" } as const;

/**
 * The frozen `MEMORY.md` snapshot of each Conversation (ADR 0009). The system prompt of a Conversation keeps the same
 * Memory text until the Conversation ends or compacts, so Memory Tool writes during the Conversation do not break LLM
 * provider prefix caching. Snapshots live in `agent.sqlite`, so they survive a daemon restart.
 *
 * The module does not know when a Conversation ends. Its row stays until `forget`, so the core Agent must call
 * `forget` for each Conversation that ends, also for the Conversation of a maintenance Run.
 *
 * Errors: no method throws a `SeamError`. File system errors from reading `MEMORY.md` and SQLite errors propagate
 * unchanged. A stored row that does not match the `memory_snapshots` schema throws an `Error`.
 */
export interface MemorySnapshots {
  /**
   * Returns the frozen snapshot of a Conversation for its system prompt. On the first call for a Conversation it takes
   * a snapshot from `MEMORY.md` and stores it. Later calls return the stored snapshot unchanged, also after Memory
   * writes, until `refresh` or `forget`.
   *
   * Errors: on the first call, the errors of `refresh`. Later calls throw only SQLite errors.
   */
  readonly get: (conversationId: string) => Promise<MemorySnapshot>;
  /**
   * Takes a new snapshot from `MEMORY.md` and freezes it for the Conversation. The core Agent calls it when a
   * Conversation starts and after each compaction (`/compact` or automatic), after the pre-compaction flush turn.
   *
   * Errors: a file system error from reading `MEMORY.md` or a SQLite error from the upsert. On an error, the stored
   * snapshot stays unchanged.
   */
  readonly refresh: (conversationId: string) => Promise<MemorySnapshot>;
  /**
   * Removes the stored snapshot, for example when `/new` replaces the Conversation or the Conversation ends. Does
   * nothing if none exists.
   *
   * Errors: SQLite errors only.
   */
  readonly forget: (conversationId: string) => Promise<void>;
}

/**
 * Formats a snapshot as the Memory section of the system prompt. Returns an empty string for an empty `MEMORY.md`.
 */
export const formatSnapshotPrompt = (snapshot: MemorySnapshot): string => {
  if (snapshot.text.trim() === "") {
    return "";
  }

  const note = snapshot.truncated
    ? "\n\n(MEMORY.md is longer than its character cap. The text above is cut. Shorten MEMORY.md with memory_write.)"
    : "";

  return `# Memory (MEMORY.md)\n\nThese are your saved notes. Use memory_search and memory_read for topic files and past Conversations.\n\n${snapshot.text}${note}`;
};

/** Options of `createMemorySnapshots`. */
export interface MemorySnapshotsOptions {
  /** The open `agent.sqlite` handle with the `memory` migrations applied. */
  readonly db: DatabaseSync;
  /** The store that reads `MEMORY.md`. */
  readonly store: MemoryStore;
  readonly clock: Clock;
}

/** Creates the snapshot store over the `memory_snapshots` table. */
export const createMemorySnapshots = (
  options: MemorySnapshotsOptions
): MemorySnapshots => {
  const { clock, db, store } = options;

  const stored = (conversationId: string): MemorySnapshot | undefined => {
    const value = db
      .prepare(
        "SELECT text, truncated FROM memory_snapshots WHERE conversation_id = ?"
      )
      .get(conversationId);

    if (value === undefined) {
      return undefined;
    }

    const row = rowOf(value, SNAPSHOT_ROW);

    return { text: row.text, truncated: row.truncated === 1 };
  };

  const refresh = async (conversationId: string): Promise<MemorySnapshot> => {
    const snapshot = await store.snapshot();

    db.prepare(
      `INSERT INTO memory_snapshots (conversation_id, text, truncated, taken_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (conversation_id) DO UPDATE SET text = excluded.text, truncated = excluded.truncated,
        taken_at = excluded.taken_at`
    ).run(
      conversationId,
      snapshot.text,
      snapshot.truncated ? 1 : 0,
      clock.now()
    );

    return snapshot;
  };

  const get = async (conversationId: string): Promise<MemorySnapshot> =>
    stored(conversationId) ?? (await refresh(conversationId));

  const forget = async (conversationId: string): Promise<void> => {
    await Promise.try(() => {
      db.prepare("DELETE FROM memory_snapshots WHERE conversation_id = ?").run(
        conversationId
      );
    });
  };

  return { forget, get, refresh };
};
