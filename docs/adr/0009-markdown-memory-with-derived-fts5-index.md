# Markdown memory with a derived SQLite FTS5 index

Each **Agent** stores its **Memory** as plain Markdown files under `~/.wheatley/agents/<name>/memory/` (`MEMORY.md` plus named `<slug>.md` topic files) as the source of truth. Wheatley stores its own state in `agent.sqlite`, separate from `@earendil-works/pi-durable`'s `harness.sqlite`. `agent.sqlite` holds **Agent** state, a **Conversation** message archive, consolidation logs, and `node:sqlite` FTS5 indexes. At **Conversation** start and after `/compact`, Wheatley injects a bounded `MEMORY.md` snapshot (default `4,000` characters). The **Agent** retrieves topic files and past **Conversations** on demand through tools.

## Considered Options

- SQLite tables as the sole source of truth for **Memory**: rejected, because plain Markdown files let the **Operator** inspect, edit, diff, and back up **Memory** directly on disk.
- One shared SQLite file with `@earendil-works/pi-durable` using table prefixes: rejected, because a shared connection couples Wheatley's schema to `pi-durable` and breaks ADR 0003.
- Hybrid FTS5 plus vector embeddings in v1: rejected, because built-in `node:sqlite` FTS5 needs zero native addons or embedding API keys. The `MemoryStore` seam lets a hybrid vector adapter plug in later.
- Reload of `MEMORY.md` on every **Run**: rejected, because a change to the system prompt mid-**Conversation** breaks LLM provider prefix caching.

## Consequences

- `src/agent/memory-store.ts` owns Markdown I/O, slug validation, `MEMORY.md` budget enforcement, FTS5 indexing, and **Conversation** archive storage with zero `@earendil-works/pi-durable` imports.
- Disk edits to `memory/` take effect on **Agent** restart or an explicit `reindex` command, with no filesystem watcher.
- `memory_write` rejects writes that exceed the `MEMORY.md` budget instead of silent truncation.
