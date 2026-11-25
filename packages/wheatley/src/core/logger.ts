import { isJsonValue } from "@wheatley-ai/protocol";
import type { LogLevel, LogRecord } from "@wheatley-ai/protocol";
import type { JsonObject, Logger } from "@wheatley-ai/sdk";

import type { Clock, EventSink } from "../contracts/module.js";

/** The number of records that `logs.tail` can return. */
export const LOG_BUFFER_SIZE = 2000;

const LEVEL_ORDER: Readonly<Record<LogLevel, number>> = {
  debug: 0,
  error: 3,
  info: 1,
  warn: 2,
};

/** A filter of `LogStore.tail`. */
export interface LogFilter {
  readonly agent?: string;
  readonly module?: string;
  /** The lowest level to return. */
  readonly level?: LogLevel;
  readonly limit: number;
}

/** Options of a `LogStore`. */
export interface LogStoreOptions {
  readonly clock: Clock;
  readonly events: EventSink;
  /** Replaces secret values in messages and fields. */
  readonly redact: (text: string) => string;
  /** Also writes each record, for example as a JSON line to stderr. */
  readonly write?: (record: LogRecord) => void;
  /** Records below this level are dropped. The default is `info`. */
  readonly minLevel?: LogLevel;
}

const isJsonObject = (value: unknown): value is JsonObject =>
  isJsonValue(value) &&
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value);

const redactFields = (
  fields: JsonObject,
  redact: (text: string) => string
): JsonObject | undefined => {
  try {
    const parsed: unknown = JSON.parse(redact(JSON.stringify(fields)));

    return isJsonObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Keeps the last `LOG_BUFFER_SIZE` diagnostic records of the daemon for `logs.tail`, and emits each record as a
 * `log.record` event. Records never contain secret values: messages and fields pass through `redact` first.
 */
export class LogStore {
  readonly #options: LogStoreOptions;
  readonly #records: LogRecord[] = [];
  #seq = 0;

  constructor(options: LogStoreOptions) {
    this.#options = options;
  }

  /** Returns a `Logger` that tags its records with `module` and, if given, `agent`. */
  readonly logger = (module: string, agent?: string): Logger => {
    const log =
      (level: LogLevel) =>
      (message: string, fields?: JsonObject): void => {
        this.#record(level, module, agent, message, fields);
      };

    return {
      debug: log("debug"),
      error: log("error"),
      info: log("info"),
      warn: log("warn"),
    };
  };

  /** Returns the newest matching records, oldest first. */
  readonly tail = (filter: LogFilter): LogRecord[] => {
    const minimum = LEVEL_ORDER[filter.level ?? "debug"];

    const matching = this.#records.filter(
      (record) =>
        LEVEL_ORDER[record.level] >= minimum &&
        (filter.agent === undefined || record.agent === filter.agent) &&
        (filter.module === undefined || record.module === filter.module)
    );

    return matching.slice(-filter.limit);
  };

  readonly #record = (
    level: LogLevel,
    module: string,
    agent: string | undefined,
    message: string,
    fields: JsonObject | undefined
  ): void => {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.#options.minLevel ?? "info"]) {
      return;
    }

    const { redact } = this.#options;

    const safeFields =
      fields === undefined ? undefined : redactFields(fields, redact);

    const record: LogRecord = {
      at: new Date(this.#options.clock.now()).toISOString(),
      level,
      message: redact(message),
      module,
      seq: this.#seq,
    };

    if (agent !== undefined) {
      record.agent = agent;
    }

    if (safeFields !== undefined) {
      record.fields = safeFields;
    }

    this.#seq += 1;
    this.#records.push(record);

    if (this.#records.length > LOG_BUFFER_SIZE) {
      this.#records.shift();
    }

    this.#options.write?.(record);
    this.#options.events.emit("log.record", { record });
  };
}
