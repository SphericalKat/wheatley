import type {
  MemoryBudget,
  MemoryFile,
  MemorySearchHit,
  MemorySearchScope,
} from "@wheatley/protocol";

/** The `MEMORY.md` text that the Agent injects at Conversation start and after `/compact` (ADR 0009). */
export interface MemorySnapshot {
  /** At most the character cap. */
  readonly text: string;
  /** True if an Operator edit on disk made `MEMORY.md` longer than the cap, so `text` is cut. */
  readonly truncated: boolean;
}

/** One user or assistant message for the Conversation archive. Tool output is never archived. */
export interface ArchivedMessage {
  readonly conversationId: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  /** Epoch milliseconds. */
  readonly at: number;
}

/** Options of `MemoryStore.search`. */
export interface MemorySearchOptions {
  readonly scope: MemorySearchScope;
  readonly limit: number;
}

/**
 * The Memory of one Agent: Markdown files under `agents/<name>/memory/` as the source of truth, plus a derived FTS5
 * index and Conversation archive in `agent.sqlite` (ADR 0009). Names are `MEMORY` (for `MEMORY.md`) or a slug that
 * matches `^[a-z0-9][a-z0-9-]{0,63}$` (for `<slug>.md`).
 *
 * The Memory module gets a `MaintenanceRunner` from the core Agent as a dependency and starts consolidation Runs
 * through it, with the `memory.consolidation.model` override.
 */
export interface MemoryStore {
  /** Reads `MEMORY.md` for injection. The caller freezes the result until the next Conversation or `/compact`. */
  readonly snapshot: () => Promise<MemorySnapshot>;
  /** Lists the Memory files and the `MEMORY.md` budget. */
  readonly list: () => Promise<{
    readonly files: readonly MemoryFile[];
    readonly budget: MemoryBudget;
  }>;
  /** Reads one file. Resolves `undefined` if it does not exist. Throws `SeamError("invalid_name")`. */
  readonly read: (name: string) => Promise<string | undefined>;
  /**
   * Writes one file and updates the index in the same step.
   *
   * Throws `SeamError("invalid_name")` for a bad name, and `SeamError("memory_budget_exceeded")` if `MEMORY.md` would
   * exceed the cap; the file then stays unchanged and the message tells the Agent to move details into a topic file.
   */
  readonly write: (
    name: string,
    content: string,
    mode: "replace" | "append"
  ) => Promise<MemoryFile>;
  /** Deletes `<slug>.md`, or empties `MEMORY.md`. Resolves `false` if the file did not exist. */
  readonly delete: (name: string) => Promise<boolean>;
  /** Full-text search, best match first. */
  readonly search: (
    query: string,
    options: MemorySearchOptions
  ) => Promise<readonly MemorySearchHit[]>;
  /** Adds one message to the Conversation archive. */
  readonly archive: (message: ArchivedMessage) => Promise<void>;
  /** Removes a Conversation from the archive and its index. Resolves with the number of removed messages. */
  readonly purgeConversation: (conversationId: string) => Promise<number>;
  /** Rebuilds the index from the files on disk. Resolves with the number of indexed files. */
  readonly reindex: () => Promise<number>;
  /**
   * The prompt of the silent pre-compaction flush turn, or `undefined` to skip the turn.
   *
   * The core Agent calls it before every compaction, from its pi-durable `beforeCompact` hook and for `/compact`. It
   * runs the prompt as one turn in the Conversation that compacts, with the Memory Tools, and delivers nothing to the
   * Chat. The model saves facts to Memory with the Memory Tools before the summary replaces the old messages.
   */
  readonly compactionFlushPrompt: () => string | undefined;
}
