import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { Type } from "typebox";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";

import { SerialQueue } from "./serial-queue.js";

const TOKEN_LENGTH = 16;

/** Returns a 16-character URL-safe key of `id` for callback data, which Telegram limits to 64 bytes. */
export const shortToken = (id: string): string =>
  createHash("sha256").update(id).digest("base64url").slice(0, TOKEN_LENGTH);

/** Options of a `TokenStore`. */
export interface TokenStoreOptions<S extends TSchema> {
  readonly dataDir: string;
  /** The file name in `dataDir`. */
  readonly file: string;
  readonly schema: S;
  /** If set, `put` removes the oldest entries until at most `capacity` remain. */
  readonly capacity?: number;
}

/**
 * Values by callback token, kept in one JSON file of the binding's data directory so that a button still works after
 * a restart.
 *
 * Invariant: every write replaces the file atomically, and writes run one at a time.
 */
export class TokenStore<S extends TSchema> {
  readonly #path: string;
  readonly #schema: S;
  readonly #capacity: number;
  #values = new Map<string, Static<S>>();
  readonly #writes = new SerialQueue();

  constructor(options: TokenStoreOptions<S>) {
    this.#path = path.join(options.dataDir, options.file);
    this.#schema = options.schema;
    this.#capacity = options.capacity ?? Number.POSITIVE_INFINITY;
  }

  /** Reads the file. A missing file is an empty store. Rejects if the file is not a valid store. */
  readonly load = async (): Promise<void> => {
    let text: string;

    try {
      text = await readFile(this.#path, "utf-8");
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return;
      }

      throw error;
    }

    const parsed: unknown = JSON.parse(text);

    if (!Value.Check(Type.Record(Type.String(), this.#schema), parsed)) {
      throw new Error(`Invalid Telegram store: ${this.#path}`);
    }

    this.#values = new Map(Object.entries(parsed));
  };

  readonly get = (token: string): Static<S> | undefined =>
    this.#values.get(token);

  /** Stores a value. Resolves once the file is written. */
  readonly put = async (token: string, value: Static<S>): Promise<void> => {
    this.#values.delete(token);
    this.#values.set(token, value);

    for (const oldest of this.#values.keys()) {
      if (this.#values.size <= this.#capacity) {
        break;
      }

      this.#values.delete(oldest);
    }

    await this.#persist();
  };

  /** Removes a value. Resolves once the file is written. */
  readonly delete = async (token: string): Promise<void> => {
    if (this.#values.delete(token)) {
      await this.#persist();
    }
  };

  readonly #persist = async (): Promise<void> => {
    await this.#writes.run(async () => {
      const temporary = `${this.#path}.tmp`;
      await writeFile(
        temporary,
        JSON.stringify(Object.fromEntries(this.#values)),
        "utf-8"
      );
      await rename(temporary, this.#path);
    });
  };
}
