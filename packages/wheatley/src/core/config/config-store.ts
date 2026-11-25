import { createHash } from "node:crypto";
import path from "node:path";

import type {
  ConfigIssue,
  DeploymentConfig,
  JsonValue,
  PermissionRule,
} from "@wheatley-ai/protocol";
import { isJsonValue } from "@wheatley-ai/protocol";
import { Document, parseDocument } from "yaml";

import type {
  ConfigSaveInput,
  ConfigSnapshot,
  ConfigStore,
} from "../../contracts/config-store.js";
import { SeamError } from "../../contracts/errors.js";
import {
  readTextIfExists,
  SerialQueue,
  writeFileAtomic,
} from "./atomic-file.js";
import { secretReferences } from "./secret-references.js";
import type { SecretReference } from "./secret-references.js";
import { FileSecretStore } from "./secret-store.js";
import { parseConfigText } from "./validate.js";
import { patchDocument } from "./yaml-patch.js";

/** The file mode of `config.yaml`. It holds no secret values (ADR 0004). */
export const CONFIG_FILE_MODE = 0o644;

/** The name of the config file in the Deployment home. */
export const CONFIG_FILE_NAME = "config.yaml";

/** The name of the secrets file in the Deployment home. */
export const SECRETS_FILE_NAME = "secrets.yaml";

/** Returns the revision of `config.yaml` text: its SHA-256 hash in hex. */
export const configRevision = (raw: string): string =>
  createHash("sha256").update(raw).digest("hex");

/** Options of `FileConfigStore.open`. */
export interface FileConfigStoreOptions {
  /** The Deployment home that holds `config.yaml` and `secrets.yaml`. */
  readonly homeDir: string;
  /** Environment variables that override secrets with the same name. */
  readonly env: Readonly<Record<string, string | undefined>>;
}

const invalidConfig = (issues: readonly ConfigIssue[]): SeamError =>
  new SeamError("config_invalid", "config.yaml is invalid", {
    issues: issues.map(({ message, path: issuePath }) => ({
      message,
      path: issuePath,
    })),
  });

/** Holds the secret references of the last config that the store read or wrote. */
interface ReferenceHolder {
  current: ReadonlyMap<string, readonly SecretReference[]>;
}

/** A config as plain JSON. */
const configJson = (config: DeploymentConfig): JsonValue => {
  // A JSON round trip drops fields whose value is `undefined`, which a structured clone would keep.
  // oxlint-disable-next-line unicorn/prefer-structured-clone -- The clone must drop `undefined` fields.
  const value: unknown = JSON.parse(JSON.stringify(config));

  if (!isJsonValue(value)) {
    throw new Error("The config is not JSON");
  }

  return value;
};

/** Applies a structured config to the current YAML text as a patch. */
const patchedText = (current: string, config: DeploymentConfig): string => {
  const value = configJson(config);
  const doc = parseDocument(current);

  if (doc.errors.length > 0) {
    // The current file is broken YAML, so no comments can be kept: write the config as a new document.
    return new Document(value).toString();
  }

  patchDocument(doc, value);

  return doc.toString();
};

const validateConfigText = async (
  raw: string
): Promise<readonly ConfigIssue[]> => {
  await Promise.resolve();
  const parsed = parseConfigText(raw);

  return parsed.ok ? [] : parsed.issues;
};

const sameRule = (
  left: PermissionRule | undefined,
  right: PermissionRule
): boolean => left?.tool === right.tool && left.action === right.action;

/**
 * The `ConfigStore` over `config.yaml` (ADR 0004). It reads the file on every `read`, so hand edits are visible. Writes
 * patch the YAML document, so comments and key order stay, and replace the file atomically, one write at a time.
 */
export class FileConfigStore implements ConfigStore {
  readonly secrets: FileSecretStore;
  readonly #file: string;
  readonly #queue = new SerialQueue();
  readonly #references: ReferenceHolder;

  private constructor(
    file: string,
    secrets: FileSecretStore,
    references: ReferenceHolder
  ) {
    this.#file = file;
    this.secrets = secrets;
    this.#references = references;
  }

  /**
   * Opens the store, loads `secrets.yaml`, and reads `config.yaml` once if it exists, so that secret references are
   * known. Throws `SeamError("config_invalid")` for an invalid secrets file.
   */
  static async open(options: FileConfigStoreOptions): Promise<FileConfigStore> {
    const references: ReferenceHolder = { current: new Map() };

    const secrets = await FileSecretStore.open({
      env: options.env,
      file: path.join(options.homeDir, SECRETS_FILE_NAME),
      references: () => references.current,
    });

    const store = new FileConfigStore(
      path.join(options.homeDir, CONFIG_FILE_NAME),
      secrets,
      references
    );

    const parsed = parseConfigText(await store.#readRaw());

    if (parsed.ok) {
      references.current = secretReferences(parsed.config);
    }

    return store;
  }

  readonly read = async (): Promise<ConfigSnapshot> => {
    const raw = await this.#readRaw();
    const parsed = parseConfigText(raw);

    if (!parsed.ok) {
      throw invalidConfig(parsed.issues);
    }

    return this.#snapshot(raw, parsed.config);
  };

  readonly validate = validateConfigText;

  readonly save = async (
    input: ConfigSaveInput,
    expectedRevision: string
  ): Promise<ConfigSnapshot> =>
    await this.#queue.run(async () => {
      const current = await this.#readRaw();
      const revision = configRevision(current);

      if (revision !== expectedRevision) {
        throw new SeamError(
          "revision_conflict",
          "config.yaml changed since it was read",
          { revision }
        );
      }

      const raw =
        "raw" in input ? input.raw : patchedText(current, input.config);

      return await this.#write(raw);
    });

  readonly prependPermissionRule = async (
    agent: string,
    rule: PermissionRule
  ): Promise<ConfigSnapshot> =>
    await this.#queue.run(async () => {
      const current = await this.#readRaw();
      const parsed = parseConfigText(current);

      if (!parsed.ok) {
        throw invalidConfig(parsed.issues);
      }

      const agentConfig = parsed.config.agents[agent];

      if (agentConfig === undefined) {
        throw new SeamError("agent_not_found", `Unknown Agent: ${agent}`);
      }

      const policy = agentConfig.permissionPolicy ?? [];

      if (sameRule(policy[0], rule)) {
        return this.#snapshot(current, parsed.config);
      }

      const next: DeploymentConfig = {
        ...parsed.config,
        agents: {
          ...parsed.config.agents,
          [agent]: { ...agentConfig, permissionPolicy: [rule, ...policy] },
        },
      };

      return await this.#write(patchedText(current, next));
    });

  readonly #write = async (raw: string): Promise<ConfigSnapshot> => {
    const parsed = parseConfigText(raw);

    if (!parsed.ok) {
      throw invalidConfig(parsed.issues);
    }

    await writeFileAtomic(this.#file, raw, CONFIG_FILE_MODE);

    return this.#snapshot(raw, parsed.config);
  };

  readonly #readRaw = async (): Promise<string> =>
    (await readTextIfExists(this.#file)) ?? "";

  readonly #snapshot = (
    raw: string,
    config: DeploymentConfig
  ): ConfigSnapshot => {
    this.#references.current = secretReferences(config);

    return { config, raw, revision: configRevision(raw) };
  };
}
