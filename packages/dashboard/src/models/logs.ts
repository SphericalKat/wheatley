import type { LogLevel, LogRecord } from "@wheatley/protocol";

import type { RpcClient } from "../rpc/client.js";
import { createStore, errorMessage } from "../store.js";
import type { Store } from "../store.js";

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

/** Creates the Logs model and loads it once the client is ready. */
export const createLogTail = (client: RpcClient): LogTail => {
  const state = createStore<LogTailState>({
    error: null,
    filter: {},
    loading: true,
    records: [],
  });

  let generation = 0;

  const load = async (): Promise<void> => {
    generation += 1;

    const requested = generation;
    const { filter } = state.get();

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
          records,
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

  const offs = [
    client.onReady(() => {
      void load();
    }),
    client.on("log.record", ({ record }) => {
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
  ];

  if (client.state.get().status === "open") {
    void load();
  }

  return {
    dispose: () => {
      for (const off of offs) {
        off();
      }
    },
    setFilter: async (filter) => {
      state.update((current) => ({ ...current, filter }));
      await load();
    },
    state,
  };
};
