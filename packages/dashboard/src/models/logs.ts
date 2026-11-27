import type { LogLevel, LogRecord } from "@wheatley-ai/protocol";

import type { RpcClient } from "../rpc/client.js";
import { createStore, errorMessage } from "../store.js";
import type { Store } from "../store.js";
import { disposeAll, loadOnReady } from "./lifecycle.js";

/** Which log records the Logs view shows. */
export interface LogFilter {
  readonly agent?: string;
  /** The lowest level to show. */
  readonly level?: LogLevel;
  readonly module?: string;
}

/** The Logs view: the latest records that match the filter, oldest first. */
export interface LogTailState {
  readonly filter: LogFilter;
  readonly records: readonly LogRecord[];
  readonly loading: boolean;
  readonly error: string | null;
}

/** The Logs model. It loads the tail with `logs.tail` and appends `log.record` events that match the filter. */
export interface LogTail {
  readonly state: Store<LogTailState>;
  /** Replaces the filter and loads the tail again. */
  readonly setFilter: (filter: LogFilter) => Promise<void>;
  /** Removes the `log.record` and reconnect listeners. */
  readonly dispose: () => void;
}

/** The number of records that the Logs view keeps. */
export const LOG_TAIL_LIMIT = 500;

const LEVEL_ORDER: readonly LogLevel[] = ["debug", "info", "warn", "error"];

/** Returns true if `record` passes `filter`. */
export const matchesLogFilter = (
  record: LogRecord,
  filter: LogFilter
): boolean => {
  const minimum = LEVEL_ORDER.indexOf(filter.level ?? "debug");
  const levelMatches = LEVEL_ORDER.indexOf(record.level) >= minimum;

  const agentMatches =
    filter.agent === undefined || record.agent === filter.agent;

  const moduleMatches =
    filter.module === undefined || record.module === filter.module;

  return levelMatches && agentMatches && moduleMatches;
};

/** Merges the tail with the records that arrived during its load, by `seq`, and keeps the newest. */
const mergeRecords = (
  tail: readonly LogRecord[],
  arrived: readonly LogRecord[]
): readonly LogRecord[] => {
  const known = new Set(tail.map((record) => record.seq));
  const extra = arrived.filter((record) => !known.has(record.seq));

  if (extra.length === 0) {
    return tail;
  }

  return [...tail, ...extra]
    .toSorted((left, right) => left.seq - right.seq)
    .slice(-LOG_TAIL_LIMIT);
};

/** Creates the Logs model and loads it once the client is ready. */
export const createLogTail = (client: RpcClient): LogTail => {
  const state = createStore<LogTailState>({
    error: null,
    filter: {},
    loading: true,
    records: [],
  });

  let generation = 0;
  // Records that arrived since the latest load started. The tail was read before them.
  let arrived: LogRecord[] = [];

  const load = async (): Promise<void> => {
    generation += 1;

    const requested = generation;
    const { filter } = state.get();

    arrived = [];

    state.update((current) => ({ ...current, loading: true }));

    try {
      const { records } = await client.call("logs.tail", {
        ...filter,
        limit: LOG_TAIL_LIMIT,
      });

      if (requested === generation) {
        state.update((current) => ({
          ...current,
          error: null,
          loading: false,
          records: mergeRecords(records, arrived),
        }));
      }
    } catch (error) {
      if (requested === generation) {
        state.update((current) => ({
          ...current,
          error: errorMessage(error),
          loading: false,
        }));
      }
    }
  };

  const dispose = disposeAll([
    loadOnReady(client, () => {
      void load();
    }),
    client.on("log.record", ({ record }) => {
      if (matchesLogFilter(record, state.get().filter)) {
        arrived.push(record);
      }

      state.update((current) => {
        const known = current.records.some((entry) => entry.seq === record.seq);

        if (known || !matchesLogFilter(record, current.filter)) {
          return current;
        }

        return {
          ...current,
          records: [...current.records, record].slice(-LOG_TAIL_LIMIT),
        };
      });
    }),
  ]);

  return {
    dispose,
    setFilter: async (filter) => {
      state.update((current) => ({ ...current, filter }));
      await load();
    },
    state,
  };
};
