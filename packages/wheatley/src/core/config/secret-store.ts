import type {
  ConfigIssue,
  SecretInfo,
  SecretSource,
} from "@wheatley-ai/protocol";
import { isMap, isScalar, parseDocument } from "yaml";
import type { Document } from "yaml";

import type { SecretStore } from "../../contracts/config-store.js";
import { SeamError } from "../../contracts/errors.js";
import {
  readTextIfExists,
  SerialQueue,
  writeFileAtomic,
} from "./atomic-file.js";
import type { SecretReference } from "./secret-references.js";

/** The file mode of `secrets.yaml`: read and write for the owner only. */
export const SECRETS_FILE_MODE = 0o600;

const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const MIN_REDACTED_LENGTH = 4;
const REDACTED = "[redacted]";

/** Options of `FileSecretStore.open`. */
export interface FileSecretStoreOptions {
  /** The path of `secrets.yaml`. */
  readonly file: string;
  /** Environment variables. A variable with the name of a secret wins over the file value. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The config entries that refer to each secret, from the last `config.yaml` that the Config Store read or wrote. */
  readonly references: () => ReadonlyMap<string, readonly SecretReference[]>;
}

interface LoadedSecrets {
  readonly doc: Document;
  readonly values: ReadonlyMap<string, string>;
}

const isText = (value: unknown): value is string => typeof value === "string";

const invalid = (file: string, issues: readonly ConfigIssue[]): SeamError =>
  new SeamError("config_invalid", "secrets.yaml is invalid", {
    file,
    issues: issues.map(({ message, path }) => ({ message, path })),
  });

/**
 * Parses `secrets.yaml`: a map of secret names to string values. An empty or missing file has no secrets. `file` is the
 * path that holds `raw`, for the error details.
 */
const parseSecrets = (file: string, raw: string): LoadedSecrets => {
  const doc = parseDocument(raw, { prettyErrors: false });

  if (doc.errors.length > 0) {
    throw invalid(
      file,
      doc.errors.map((error) => ({ message: error.message, path: "/" }))
    );
  }

  const values = new Map<string, string>();

  if (doc.contents === null) {
    return { doc, values };
  }

  if (!isMap(doc.contents)) {
    throw invalid(file, [
      { message: "secrets.yaml must be a map of names to values", path: "/" },
    ]);
  }

  const issues: ConfigIssue[] = [];

  for (const pair of doc.contents.items) {
    const key = isScalar(pair.key) ? pair.key.value : pair.key;
    const value = isScalar(pair.value) ? pair.value.value : pair.value;

    if (!isText(key) || !SECRET_NAME.test(key)) {
      issues.push({
        message: `Invalid secret name: ${String(key)}`,
        path: "/",
      });
    } else if (isText(value)) {
      values.set(key, value);
    } else {
      issues.push({
        message: "A secret value must be a string",
        path: `/${key}`,
      });
    }
  }

  if (issues.length > 0) {
    throw invalid(file, issues);
  }

  return { doc, values };
};

/**
 * The `SecretStore` over `secrets.yaml` (ADR 0004). Writes keep comments, are atomic, run one at a time, and keep the
 * file mode `0600`. `get` and `redact` use the values that the last `open`, `set`, or `delete` loaded.
 */
export class FileSecretStore implements SecretStore {
  readonly #options: FileSecretStoreOptions;
  readonly #queue = new SerialQueue();
  #values: ReadonlyMap<string, string>;

  private constructor(
    options: FileSecretStoreOptions,
    values: ReadonlyMap<string, string>
  ) {
    this.#options = options;
    this.#values = values;
  }

  /** Loads `secrets.yaml`. Throws `SeamError("config_invalid")` for a file that is not a map of string values. */
  static async open(options: FileSecretStoreOptions): Promise<FileSecretStore> {
    const raw = (await readTextIfExists(options.file)) ?? "";

    return new FileSecretStore(options, parseSecrets(options.file, raw).values);
  }

  readonly get = (name: string): string | undefined =>
    this.#options.env[name] ?? this.#values.get(name);

  readonly list = async (): Promise<readonly SecretInfo[]> => {
    await Promise.resolve();
    const references = this.#options.references();

    const names = new Set([
      ...this.#values.keys(),
      ...[...references.keys()].filter(
        (name) => this.#options.env[name] !== undefined
      ),
    ]);

    return [...names].toSorted().map((name) => ({
      name,
      references: [...(references.get(name) ?? [])],
      source: this.#sourceOf(name),
    }));
  };

  readonly set = async (name: string, value: string): Promise<SecretSource> => {
    if (!SECRET_NAME.test(name)) {
      throw new SeamError("invalid_name", `Invalid secret name: ${name}`);
    }

    await this.#change((doc) => {
      doc.set(name, value);
    });

    return this.#sourceOf(name);
  };

  readonly delete = async (name: string): Promise<boolean> => {
    let deleted = false;

    await this.#change((doc) => {
      deleted = doc.delete(name);
    });

    return deleted;
  };

  readonly reveal = async (name: string): Promise<string> => {
    await Promise.resolve();
    const value = this.get(name);

    if (value === undefined) {
      throw new SeamError("not_found", `Unknown secret: ${name}`);
    }

    return value;
  };

  readonly redact = (text: string): string => {
    const names = new Set([
      ...this.#values.keys(),
      ...this.#options.references().keys(),
    ]);

    const values = [...names]
      .flatMap((name) => {
        const value = this.get(name);

        return value === undefined || value.length < MIN_REDACTED_LENGTH
          ? []
          : [value, JSON.stringify(value).slice(1, -1)];
      })
      .toSorted((left, right) => right.length - left.length);

    let redacted = text;

    for (const value of values) {
      redacted = redacted.replaceAll(value, REDACTED);
    }

    return redacted;
  };

  /** Re-reads the file, applies `edit` to its document, writes it, and reloads the values. One change at a time. */
  readonly #change = async (edit: (doc: Document) => void): Promise<void> => {
    await this.#queue.run(async () => {
      const raw = (await readTextIfExists(this.#options.file)) ?? "";
      const { doc } = parseSecrets(this.#options.file, raw);

      doc.contents ??= doc.createNode({});

      edit(doc);
      const text = doc.toString();

      await writeFileAtomic(this.#options.file, text, SECRETS_FILE_MODE);
      this.#values = parseSecrets(this.#options.file, text).values;
    });
  };

  readonly #sourceOf = (name: string): SecretSource => {
    const inFile = this.#values.has(name);
    const inEnv = this.#options.env[name] !== undefined;

    if (inFile && inEnv) {
      return "both";
    }

    return inEnv ? "env" : "file";
  };
}
