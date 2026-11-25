import type { Migration } from "../db/migrations.js";

/**
 * The `memory` migration namespace of `agent.sqlite` (ADR 0009).
 *
 * - `memory_files_fts`: the derived FTS5 index of the Markdown files. `reindex` rebuilds it from disk.
 * - `memory_messages` and `memory_messages_fts`: the user and assistant Conversation archive and its index. Triggers
 *   keep the external-content index in step with the archive.
 * - `memory_consolidations`: the consolidation log.
 */
export const memoryMigrations: readonly Migration[] = [
  {
    name: "create memory index, archive, snapshots, and consolidation log",
    up: (db) => {
      db.exec(`
        CREATE VIRTUAL TABLE memory_files_fts USING fts5(
          name UNINDEXED,
          title,
          content,
          tokenize = 'porter unicode61 remove_diacritics 2'
        );

        CREATE TABLE memory_messages (
          id INTEGER PRIMARY KEY,
          conversation_id TEXT NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
          text TEXT NOT NULL,
          at INTEGER NOT NULL
        ) STRICT;

        CREATE INDEX memory_messages_conversation ON memory_messages (conversation_id);

        CREATE VIRTUAL TABLE memory_messages_fts USING fts5(
          text,
          content = 'memory_messages',
          content_rowid = 'id',
          tokenize = 'porter unicode61 remove_diacritics 2'
        );

        CREATE TRIGGER memory_messages_ai AFTER INSERT ON memory_messages BEGIN
          INSERT INTO memory_messages_fts (rowid, text) VALUES (new.id, new.text);
        END;

        CREATE TRIGGER memory_messages_ad AFTER DELETE ON memory_messages BEGIN
          INSERT INTO memory_messages_fts (memory_messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
        END;

        CREATE TABLE memory_snapshots (
          conversation_id TEXT PRIMARY KEY,
          text TEXT NOT NULL,
          truncated INTEGER NOT NULL CHECK (truncated IN (0, 1)),
          taken_at INTEGER NOT NULL
        ) STRICT;

        CREATE TABLE memory_consolidations (
          id TEXT PRIMARY KEY,
          run_id TEXT,
          status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
          started_at INTEGER NOT NULL,
          ended_at INTEGER,
          summary TEXT,
          error TEXT
        ) STRICT;

        CREATE INDEX memory_consolidations_started ON memory_consolidations (started_at);
      `);
    },
    version: 1,
  },
  {
    name: "drop memory snapshots",
    // The Conversation instructions in `harness.sqlite` hold the frozen `MEMORY.md` snapshot, so this table is unused.
    up: (db) => {
      db.exec("DROP TABLE memory_snapshots;");
    },
    version: 2,
  },
];
