import type { JsonObject, Logger } from "@wheatley/sdk";

/** One record of `RecordingLogger`. */
export interface LogRecord {
  readonly level: "debug" | "info" | "warn" | "error";
  readonly message: string;
  readonly fields: JsonObject | undefined;
}

/** A `Logger` that records every record. */
export class RecordingLogger implements Logger {
  readonly records: LogRecord[] = [];

  readonly debug = (message: string, fields?: JsonObject): void => {
    this.records.push({ fields, level: "debug", message });
  };

  readonly info = (message: string, fields?: JsonObject): void => {
    this.records.push({ fields, level: "info", message });
  };

  readonly warn = (message: string, fields?: JsonObject): void => {
    this.records.push({ fields, level: "warn", message });
  };

  readonly error = (message: string, fields?: JsonObject): void => {
    this.records.push({ fields, level: "error", message });
  };
}
