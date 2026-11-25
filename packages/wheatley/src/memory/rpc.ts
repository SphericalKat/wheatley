import { SeamError } from "../contracts/errors.js";
import type { MemoryStore } from "../contracts/memory-store.js";
import type { RpcHandlerMap } from "../contracts/module.js";
import type { MemoryConsolidation } from "./consolidation.js";
import { memoryFileName } from "./names.js";

/** The default number of hits of `memory.search`. */
const RPC_SEARCH_LIMIT = 20;

/** The default number of entries of `memory.consolidationLog`. */
const DEFAULT_LOG_LIMIT = 20;

/**
 * Creates the Operator JSON-RPC handlers of the `memory.*` methods for one Agent. Expected failures throw a
 * `SeamError`, which the router converts with `toRpcError`:
 * - `invalid_name` for a bad Memory name.
 * - `memory_budget_exceeded` for a `MEMORY.md` write over the cap.
 * - `not_found` for `memory.read` of a file that does not exist.
 * - `conflict` for `memory.consolidate` while a consolidation runs.
 */
export const createMemoryRpcHandlers = (
  store: MemoryStore,
  consolidation: MemoryConsolidation
): RpcHandlerMap => ({
  "memory.consolidate": async () => await consolidation.run(),
  "memory.consolidationLog": async (params) =>
    await Promise.try(() => ({
      entries: [...consolidation.log(params.limit ?? DEFAULT_LOG_LIMIT)],
    })),
  "memory.delete": async (params) => ({
    deleted: await store.delete(params.name),
  }),
  "memory.list": async () => {
    const { budget, files } = await store.list();

    return { budget, files: [...files] };
  },
  "memory.purgeConversation": async (params) => ({
    purgedMessages: await store.purgeConversation(params.conversationId),
  }),
  "memory.read": async (params) => {
    const content = await store.read(params.name);

    if (content === undefined) {
      throw new SeamError(
        "not_found",
        `Memory file ${memoryFileName(params.name)} does not exist`
      );
    }

    return { content, name: params.name };
  },
  "memory.reindex": async () => ({ files: await store.reindex() }),
  "memory.search": async (params) => ({
    hits: [
      ...(await store.search(params.query, {
        limit: params.limit ?? RPC_SEARCH_LIMIT,
        scope: params.scope ?? "all",
      })),
    ],
  }),
  "memory.write": async (params) => ({
    file: await store.write(
      params.name,
      params.content,
      params.mode ?? "replace"
    ),
  }),
});
