import { randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import type {
  MemoryBudget,
  MemoryFile,
  MemorySearchHit,
} from "@wheatley/protocol";

import { SeamError } from "../contracts/errors.js";
import type {
  ArchivedMessage,
  MemorySearchOptions,
  MemorySnapshot,
  MemoryStore,
} from "../contracts/memory-store.js";
import type { Clock } from "../contracts/module.js";
import {
  assertMemoryName,
  MEMORY_NAME,
  memoryFileName,
  memoryFilePath,
  memoryNameOfFile,
} from "./names.js";
import { rowOf } from "./rows.js";

/** The default `MEMORY.md` character cap (ADR 0009). */
export const DEFAULT_MEMORY_MAX_CHARS = 4000;

/** The number of tokens around a match in a search hit snippet. */
const SNIPPET_TOKENS = 24;

const SEARCH_TOKEN = /[\p{L}\p{N}_]+/gu;
const SLUG_SEPARATOR = /-/gu;

/** A change to the Memory files, for the `memory.changed` event. */
export interface MemoryChange {
  readonly change: "written" | "deleted" | "reindexed";
  readonly name?: string;
}

/** Options of `createMarkdownMemoryStore`. */
export interface MarkdownMemoryStoreOptions {
  /** The Memory folder, `agents/<name>/memory/`. The store creates it on the first write. */
  readonly dir: string;
  /** The open `agent.sqlite` handle with the `memory` migrations applied. */
  readonly db: DatabaseSync;
  readonly clock: Clock;
  /** The `MEMORY.md` character cap. The default is 4,000. */
  readonly maxChars?: number;
  /** Called after each successful write, delete, and reindex. Must not throw. */
  readonly onChange?: (change: MemoryChange) => void;
}

/** A file on disk with its Memory name. */
interface DiskFile {
  readonly name: string;
  readonly content: string;
  readonly updatedAt: string;
}

const FILE_HIT = { name: "text", rank: "number", snippet: "text" } as const;

const MESSAGE_HIT = {
  at: "number",
  conversation_id: "text",
  rank: "number",
  role: "text",
  snippet: "text",
} as const;

const isMissingFile = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

const readOptional = async (filePath: string): Promise<string | undefined> => {
  try {
    return await readFile(filePath, "utf-8");
  } catch (error) {
    if (isMissingFile(error)) {
      return undefined;
    }

    throw error;
  }
};

const titleOf = (name: string): string =>
  name === MEMORY_NAME ? "memory" : name.replaceAll(SLUG_SEPARATOR, " ");

const appendText = (previous: string, content: string): string => {
  if (previous === "") {
    return content;
  }

  return previous.endsWith("\n")
    ? `${previous}${content}`
    : `${previous}\n${content}`;
};

/**
 * Builds an FTS5 query that matches any word of `query`. Each word becomes a quoted string, so FTS5 operators and
 * punctuation in model or Operator input cannot cause a syntax error. Returns `undefined` if `query` has no words.
 */
const ftsQuery = (query: string): string | undefined => {
  const words = query.match(SEARCH_TOKEN);

  if (words === null) {
    return undefined;
  }

  return words.map((word) => `"${word}"`).join(" OR ");
};

/** Converts an FTS5 `bm25` rank, where lower is better, to a score where higher is better. */
const scoreOf = (rank: number): number => -rank;

const metadataOf = (file: DiskFile): MemoryFile => ({
  chars: file.content.length,
  name: file.name,
  updatedAt: file.updatedAt,
});

const runInTransaction = (db: DatabaseSync, work: () => void): void => {
  db.exec("BEGIN IMMEDIATE");

  try {
    work();
    db.exec("COMMIT");
  } catch (error) {
    if (db.isTransaction) {
      db.exec("ROLLBACK");
    }

    throw error;
  }
};

/**
 * Creates the `MemoryStore` of one Agent (ADR 0009). The Markdown files in `dir` are the source of truth. The FTS5
 * index in `agent.sqlite` is derived from them: each write and delete updates it, and `reindex` rebuilds it from disk.
 * The Conversation archive lives in `agent.sqlite` only.
 *
 * The store serializes its file changes, so concurrent `append` writes do not lose text. It writes each file to a
 * temporary file and renames it, so a crash never leaves a half-written Memory file.
 */
export const createMarkdownMemoryStore = (
  options: MarkdownMemoryStoreOptions
): MemoryStore => {
  const { db, dir } = options;
  const maxChars = options.maxChars ?? DEFAULT_MEMORY_MAX_CHARS;
  let tail: Promise<unknown> = Promise.resolve();

  /** Runs file changes one at a time, in call order. A failed change does not block later changes. */
  const serialize = async <T>(task: () => Promise<T>): Promise<T> => {
    const result = tail.then(task);
    tail = Promise.allSettled([result]);

    return await result;
  };

  const readDiskFile = async (name: string): Promise<DiskFile | undefined> => {
    const filePath = memoryFilePath(dir, name);
    const content = await readOptional(filePath);

    if (content === undefined) {
      return undefined;
    }

    const { mtimeMs } = await stat(filePath);

    return { content, name, updatedAt: new Date(mtimeMs).toISOString() };
  };

  const readDisk = async (): Promise<DiskFile[]> => {
    let entries: string[];

    try {
      entries = await readdir(dir);
    } catch (error) {
      if (isMissingFile(error)) {
        return [];
      }

      throw error;
    }

    const names = entries.flatMap((entry) => {
      const name = memoryNameOfFile(entry);

      return name === undefined ? [] : [name];
    });

    const read = await Promise.all(names.map(readDiskFile));
    const files = read.filter((file) => file !== undefined);

    return files.toSorted((left, right) => {
      if (left.name === MEMORY_NAME) {
        return -1;
      }

      if (right.name === MEMORY_NAME) {
        return 1;
      }

      return left.name.localeCompare(right.name);
    });
  };

  const indexFile = (name: string, content: string): void => {
    db.prepare("DELETE FROM memory_files_fts WHERE name = ?").run(name);

    if (content !== "") {
      db.prepare(
        "INSERT INTO memory_files_fts (name, title, content) VALUES (?, ?, ?)"
      ).run(name, titleOf(name), content);
    }
  };

  const writeAtomically = async (
    name: string,
    content: string
  ): Promise<void> => {
    await mkdir(dir, { recursive: true });

    const temporary = path.join(
      dir,
      `.${memoryFileName(name)}.${randomUUID()}.tmp`
    );

    try {
      await writeFile(temporary, content, "utf-8");
      await rename(temporary, memoryFilePath(dir, name));
    } catch (error) {
      await rm(temporary, { force: true });

      throw error;
    }
  };

  const snapshot = async (): Promise<MemorySnapshot> => {
    const text = (await readOptional(memoryFilePath(dir, MEMORY_NAME))) ?? "";

    return { text: text.slice(0, maxChars), truncated: text.length > maxChars };
  };

  const list = async (): Promise<{
    readonly files: readonly MemoryFile[];
    readonly budget: MemoryBudget;
  }> => {
    const files = await readDisk();
    const memory = files.find((file) => file.name === MEMORY_NAME);

    return {
      budget: { maxChars, usedChars: memory?.content.length ?? 0 },
      files: files.map(metadataOf),
    };
  };

  const read = async (name: string): Promise<string | undefined> => {
    assertMemoryName(name);

    return await readOptional(memoryFilePath(dir, name));
  };

  const write = async (
    name: string,
    content: string,
    mode: "replace" | "append"
  ): Promise<MemoryFile> => {
    assertMemoryName(name);

    return await serialize(async () => {
      const previous = (await readOptional(memoryFilePath(dir, name))) ?? "";
      const next = mode === "append" ? appendText(previous, content) : content;

      if (name === MEMORY_NAME && next.length > maxChars) {
        throw new SeamError(
          "memory_budget_exceeded",
          `MEMORY.md would have ${next.length} characters, but the cap is ${maxChars}. MEMORY.md stays unchanged. Keep MEMORY.md short and move details into a topic file, for example memory_write with name "travel".`,
          { maxChars, requestedChars: next.length }
        );
      }

      await writeAtomically(name, next);
      runInTransaction(db, () => {
        indexFile(name, next);
      });
      const file = await readDiskFile(name);

      if (file === undefined) {
        throw new Error(`Memory file ${name} vanished after the write`);
      }

      options.onChange?.({ change: "written", name });

      return metadataOf(file);
    });
  };

  const remove = async (name: string): Promise<boolean> => {
    assertMemoryName(name);

    return await serialize(async () => {
      const filePath = memoryFilePath(dir, name);

      if ((await readOptional(filePath)) === undefined) {
        return false;
      }

      await (name === MEMORY_NAME
        ? writeAtomically(name, "")
        : rm(filePath, { force: true }));

      runInTransaction(db, () => {
        indexFile(name, "");
      });
      options.onChange?.({ change: "deleted", name });

      return true;
    });
  };

  const searchFiles = (match: string, limit: number): MemorySearchHit[] =>
    db
      .prepare(
        `SELECT name, bm25(memory_files_fts) AS rank,
          snippet(memory_files_fts, 2, '', '', '…', ${SNIPPET_TOKENS}) AS snippet
        FROM memory_files_fts WHERE memory_files_fts MATCH ? ORDER BY rank LIMIT ?`
      )
      .all(match, limit)
      .map((value) => rowOf(value, FILE_HIT))
      .map((row) => ({
        kind: "memory",
        name: row.name,
        score: scoreOf(row.rank),
        snippet: row.snippet,
      }));

  const searchArchive = (match: string, limit: number): MemorySearchHit[] =>
    db
      .prepare(
        `SELECT m.conversation_id, m.role, m.at, bm25(memory_messages_fts) AS rank,
          snippet(memory_messages_fts, 0, '', '', '…', ${SNIPPET_TOKENS}) AS snippet
        FROM memory_messages_fts JOIN memory_messages AS m ON m.id = memory_messages_fts.rowid
        WHERE memory_messages_fts MATCH ? ORDER BY rank LIMIT ?`
      )
      .all(match, limit)
      .map((value) => rowOf(value, MESSAGE_HIT))
      .map((row) => ({
        at: new Date(row.at).toISOString(),
        conversationId: row.conversation_id,
        kind: "conversation",
        role: row.role === "user" ? "user" : "assistant",
        score: scoreOf(row.rank),
        snippet: row.snippet,
      }));

  const searchNow = (
    query: string,
    searchOptions: MemorySearchOptions
  ): readonly MemorySearchHit[] => {
    const match = ftsQuery(query);

    if (match === undefined || searchOptions.limit < 1) {
      return [];
    }

    const files =
      searchOptions.scope === "conversations"
        ? []
        : searchFiles(match, searchOptions.limit);

    const messages =
      searchOptions.scope === "memory"
        ? []
        : searchArchive(match, searchOptions.limit);

    return [...files, ...messages]
      .toSorted((left, right) => right.score - left.score)
      .slice(0, searchOptions.limit);
  };

  const search = async (
    query: string,
    searchOptions: MemorySearchOptions
  ): Promise<readonly MemorySearchHit[]> =>
    await Promise.try(() => searchNow(query, searchOptions));

  const archive = async (message: ArchivedMessage): Promise<void> => {
    await Promise.try(() => {
      db.prepare(
        "INSERT INTO memory_messages (conversation_id, role, text, at) VALUES (?, ?, ?, ?)"
      ).run(message.conversationId, message.role, message.text, message.at);
    });
  };

  const purgeConversation = async (conversationId: string): Promise<number> =>
    await Promise.try(() => {
      const result = db
        .prepare("DELETE FROM memory_messages WHERE conversation_id = ?")
        .run(conversationId);

      return Number(result.changes);
    });

  const reindex = async (): Promise<number> =>
    await serialize(async () => {
      const files = await readDisk();

      runInTransaction(db, () => {
        db.exec("DELETE FROM memory_files_fts");

        for (const file of files) {
          indexFile(file.name, file.content);
        }
      });
      options.onChange?.({ change: "reindexed" });

      return files.length;
    });

  const compactionFlushPrompt = (): string =>
    [
      "This Conversation compacts next, and a summary replaces its older messages.",
      "Save what is worth keeping before that happens: durable facts, preferences, decisions, and open tasks that are not in Memory yet.",
      `Use memory_search and memory_read to check what Memory already has, and memory_write to save. Keep MEMORY.md under ${maxChars} characters and put details into topic files.`,
      "If nothing new is worth keeping, do not call a Tool. Reply with one short line.",
    ].join("\n");

  return {
    archive,
    compactionFlushPrompt,
    delete: remove,
    list,
    purgeConversation,
    read,
    reindex,
    search,
    snapshot,
    write,
  };
};
