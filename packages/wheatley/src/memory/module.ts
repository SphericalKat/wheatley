import path from "node:path";

import type { MemoryConfig } from "@wheatley/protocol";

import type { ToolProvider } from "../contracts/extension-catalog.js";
import type { MaintenanceRunner } from "../contracts/maintenance-runner.js";
import type { MemoryStore } from "../contracts/memory-store.js";
import type { AgentModule } from "../contracts/module.js";
import { createMemoryConsolidation } from "./consolidation.js";
import type { MemoryConsolidation } from "./consolidation.js";
import { memoryMigrations } from "./migrations.js";
import { MEMORY_DIR_NAME } from "./names.js";
import { createMemoryRpcHandlers } from "./rpc.js";
import { createMemorySnapshots } from "./snapshots.js";
import type { MemorySnapshots } from "./snapshots.js";
import { createMarkdownMemoryStore } from "./store.js";
import { createMemoryTools } from "./tools.js";

export {
  CONSOLIDATION_JOB,
  DEFAULT_CONSOLIDATION_SCHEDULE,
} from "./consolidation.js";

export { memoryMigrations } from "./migrations.js";

export { createMemoryRpcHandlers } from "./rpc.js";

export { formatSnapshotPrompt } from "./snapshots.js";

export { DEFAULT_MEMORY_MAX_CHARS } from "./store.js";

export { createMemoryTools } from "./tools.js";

/** The dependencies of the Memory module that the core Agent passes to `create`. */
export interface MemoryModuleDeps {
  /** `memory` of the Agent's config. Missing fields take their defaults. */
  readonly config?: MemoryConfig;
  /** Starts consolidation Runs. The core Agent implements it. */
  readonly maintenance: MaintenanceRunner;
}

/** The API of the Memory module for the core Agent. */
export interface MemoryApi {
  /** The Memory files, their index, and the Conversation archive. The core Agent archives messages through it. */
  readonly store: MemoryStore;
  /** The built-in Memory Tools, for the Agent's Tool list. */
  readonly tools: ToolProvider;
  /** The frozen `MEMORY.md` snapshot of each Conversation, for the system prompt. */
  readonly snapshots: MemorySnapshots;
  /**
   * Starts consolidation Runs on demand and reads the consolidation log. The module runs the schedule itself, so the
   * core Agent never calls `start` or `stop` of the consolidation job.
   *
   * Errors: `run` throws `SeamError("conflict")` while a consolidation runs, and propagates `MaintenanceRunner.start`
   * and SQLite errors. `log` throws SQLite errors only. See `MemoryConsolidation`.
   */
  readonly consolidation: Pick<MemoryConsolidation, "log" | "run">;
}

/**
 * The Memory module of an Agent (ADR 0009). Wave 2 wiring:
 *
 * 1. Run `migrationNamespace(memoryModule)` with the other modules' migrations on `agent.sqlite`.
 * 2. Call `create` with `{ config: agentConfig.memory, maintenance }`, and mount `rpc`.
 * 3. Add `api.tools` to the Agent's Tools. Archive each user and assistant message with `api.store.archive`.
 * 4. Inject `formatSnapshotPrompt(await api.snapshots.get(conversationId))` into the system prompt. Call
 *    `api.snapshots.refresh` at Conversation start and after each compaction. Call `api.snapshots.forget` on `/new`
 *    and when a Conversation ends, also for the Conversation of a maintenance Run.
 * 5. Before each compaction, run `api.store.compactionFlushPrompt()` as a silent turn.
 *
 * `start` rebuilds the index from the Markdown files, so disk edits take effect on Agent restart, and starts the
 * consolidation schedule (default on, daily at 03:00).
 */
export const memoryModule: AgentModule<MemoryModuleDeps, MemoryApi> = {
  create: (ctx, deps) => {
    const store = createMarkdownMemoryStore({
      clock: ctx.clock,
      db: ctx.db,
      dir: path.join(ctx.agentDir, MEMORY_DIR_NAME),
      onChange: ({ change, name }) => {
        ctx.events.emit(
          "memory.changed",
          name === undefined
            ? { agent: ctx.agentName, change }
            : { agent: ctx.agentName, change, name }
        );
      },
      maxChars: deps.config?.maxChars,
    });

    const consolidation = createMemoryConsolidation({
      clock: ctx.clock,
      db: ctx.db,
      log: ctx.log,
      runner: deps.maintenance,
      store,
      config: deps.config?.consolidation,
    });

    return {
      api: {
        consolidation: { log: consolidation.log, run: consolidation.run },
        snapshots: createMemorySnapshots({
          clock: ctx.clock,
          db: ctx.db,
          store,
        }),
        store,
        tools: createMemoryTools(store),
      },
      rpc: createMemoryRpcHandlers(store, consolidation),
      start: async () => {
        const files = await store.reindex();

        ctx.log.debug("Indexed the Memory files", { files });
        await consolidation.start();
      },
      stop: async () => {
        await consolidation.stop();
      },
    };
  },
  migrations: memoryMigrations,
  name: "memory",
  scope: "agent",
};
