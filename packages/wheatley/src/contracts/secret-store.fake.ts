import type { SecretInfo, SecretSource } from "@wheatley/protocol";

import type { SecretStore } from "./config-store.js";
import { SeamError } from "./errors.js";
import { simulateIo } from "./fake-io.js";

const MIN_REDACTED_LENGTH = 4;
const REDACTED = "[redacted]";

/** An in-memory `SecretStore`. `env` plays the role of environment variables, which win over file values. */
export class InMemorySecretStore implements SecretStore {
  readonly #file = new Map<string, string>();
  readonly #env: ReadonlyMap<string, string>;

  constructor(
    file: Readonly<Record<string, string>> = {},
    env: Readonly<Record<string, string>> = {}
  ) {
    for (const [name, value] of Object.entries(file)) {
      this.#file.set(name, value);
    }

    this.#env = new Map(Object.entries(env));
  }

  readonly get = (name: string): string | undefined =>
    this.#env.get(name) ?? this.#file.get(name);

  readonly list = async (): Promise<readonly SecretInfo[]> => {
    await simulateIo();
    const names = new Set([...this.#file.keys(), ...this.#env.keys()]);

    return [...names]
      .toSorted()
      .map((name) => ({ name, references: [], source: this.#sourceOf(name) }));
  };

  readonly set = async (name: string, value: string): Promise<SecretSource> => {
    await simulateIo();
    this.#file.set(name, value);

    return this.#sourceOf(name);
  };

  readonly delete = async (name: string): Promise<boolean> => {
    await simulateIo();

    return this.#file.delete(name);
  };

  readonly reveal = async (name: string): Promise<string> => {
    await simulateIo();
    const value = this.get(name);

    if (value === undefined) {
      throw new SeamError("not_found", `Unknown secret: ${name}`);
    }

    return value;
  };

  readonly redact = (text: string): string => {
    const values = [...this.#file.values(), ...this.#env.values()]
      .filter((value) => value.length >= MIN_REDACTED_LENGTH)
      .toSorted((left, right) => right.length - left.length);

    let redacted = text;

    for (const value of values) {
      redacted = redacted.replaceAll(value, REDACTED);
    }

    return redacted;
  };

  readonly #sourceOf = (name: string): SecretSource => {
    const inFile = this.#file.has(name);
    const inEnv = this.#env.has(name);

    if (inFile && inEnv) {
      return "both";
    }

    return inEnv ? "env" : "file";
  };
}
