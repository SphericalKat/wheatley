import type {
  ConfigIssue,
  DeploymentConfig,
  PermissionRule,
  SecretInfo,
  SecretSource,
} from "@wheatley-ai/protocol";
import type { SecretReader } from "@wheatley-ai/sdk";

/** One read of `config.yaml`. */
export interface ConfigSnapshot {
  /** A content hash of `raw`. Writes compare it with `expectedRevision`. */
  readonly revision: string;
  readonly raw: string;
  readonly config: DeploymentConfig;
}

/** What to save: raw YAML from the editor, or a structured config from the dashboard forms. */
export type ConfigSaveInput =
  | { readonly raw: string }
  | { readonly config: DeploymentConfig };

/**
 * The secrets of `secrets.yaml` plus their environment variable overrides (an environment variable with the same name
 * wins). `get` reads the values loaded at the last start or write.
 */
export interface SecretStore extends SecretReader {
  /** Lists names, sources, and the config entries that refer to each secret. Never returns values. */
  readonly list: () => Promise<readonly SecretInfo[]>;
  /**
   * Adds or rotates a secret in `secrets.yaml` (owner-only file mode `0600`, atomic write). Resolves with the source
   * after the write. A running Agent sees the new value after its restart.
   */
  readonly set: (name: string, value: string) => Promise<SecretSource>;
  /** Removes a secret from `secrets.yaml`. Resolves `false` if it was not there. Environment variables stay. */
  readonly delete: (name: string) => Promise<boolean>;
  /** Returns one value for `secrets.reveal`. Throws `SeamError("not_found")` for an unknown name. */
  readonly reveal: (name: string) => Promise<string>;
  /**
   * Replaces every occurrence of every secret value in `text` with `[redacted]`, and every occurrence of its
   * JSON-escaped form (`JSON.stringify(value)` without the quotes), so it also works on JSON text. Approvals use it for
   * `inputPreview`, and the logger uses it for records. It does not replace values shorter than 4 characters.
   */
  readonly redact: (text: string) => string;
}

/**
 * Reads and writes `config.yaml` (ADR 0004). Writes keep YAML comments, are atomic (temporary file plus rename), and
 * run one at a time. A write never restarts an Agent. The caller decides whether to restart it.
 */
export interface ConfigStore {
  /** Reads and validates `config.yaml` from disk. Throws `SeamError("config_invalid")` with `details.issues`. */
  readonly read: () => Promise<ConfigSnapshot>;
  /** Validates raw YAML without a write. Resolves with an empty list for a valid config. */
  readonly validate: (raw: string) => Promise<readonly ConfigIssue[]>;
  /**
   * Saves a new config and resolves with the new snapshot.
   *
   * Order of checks: `expectedRevision` against the file on disk (`SeamError("revision_conflict")` with
   * `details.revision`), then the full schema (`SeamError("config_invalid")`). If a check fails, `save` writes nothing.
   * `save` applies a structured `config` as a patch to the existing YAML document, so comments and key order stay.
   */
  readonly save: (
    input: ConfigSaveInput,
    expectedRevision: string
  ) => Promise<ConfigSnapshot>;
  /**
   * Prepends `rule` to the Agent's `permissionPolicy` for an `allow_always` Approval (ADR 0011).
   *
   * Has no revision check: it reads the current file, patches it, and writes it in one serialized step. Does nothing
   * if the first rule already equals `rule`. Throws `SeamError("agent_not_found")` for an unknown Agent.
   */
  readonly prependPermissionRule: (
    agent: string,
    rule: PermissionRule
  ) => Promise<ConfigSnapshot>;
  readonly secrets: SecretStore;
}
