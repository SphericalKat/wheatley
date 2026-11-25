import type { JsonObject } from "./json.js";

/** Structured diagnostic logger. Wheatley adds the Agent, Plugin, and Frontend Binding names to every record. */
export interface Logger {
  readonly debug: (message: string, fields?: JsonObject) => void;
  readonly info: (message: string, fields?: JsonObject) => void;
  readonly warn: (message: string, fields?: JsonObject) => void;
  readonly error: (message: string, fields?: JsonObject) => void;
}

/** Read access to the secret values of `secrets.yaml` and their environment variable overrides. */
export interface SecretReader {
  /**
   * Returns the value of the secret `name`, or `undefined` if no secret has that name.
   *
   * Never log the value. Config refers to secrets by name only.
   */
  readonly get: (name: string) => string | undefined;
}
