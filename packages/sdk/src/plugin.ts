import type { Frontend } from "./frontend.js";
import type { JsonValue } from "./json.js";
import type { Logger, SecretReader } from "./logger.js";
import type { SchemaInput } from "./schema.js";
import type { Tool } from "./tool.js";

/** The extension API version that this SDK implements. Wheatley skips Plugins with another `apiVersion`. */
export const API_VERSION = 1;

/** Services that Wheatley gives a Plugin during `setup`. */
export interface PluginSetupContext<Config = JsonValue> {
  /** The Plugin's `config` block from `config.yaml`, validated against `configSchema`. */
  readonly config: Config;
  readonly agentName: string;
  /** A private data directory for this Plugin in this Agent. */
  readonly dataDir: string;
  readonly secrets: SecretReader;
  readonly log: Logger;
  /** Aborts when the Agent stops during `setup`. */
  readonly signal: AbortSignal;
}

/** What a Plugin adds to one Agent. */
export interface PluginContributions {
  // oxlint-disable-next-line typescript/no-explicit-any -- Tool input is contravariant; each Tool validates its own input type.
  readonly tools?: readonly Tool<any>[];
  // oxlint-disable-next-line typescript/no-explicit-any -- Frontend config is contravariant; each Frontend validates its own config type.
  readonly frontends?: readonly Frontend<any>[];
  /** Releases resources when the Agent stops or restarts. */
  readonly dispose?: () => Promise<void> | void;
}

/**
 * An in-process extension that an Agent loads through `import()` (ADR 0006).
 *
 * A Plugin module default-exports this object. Each Agent that lists the Plugin calls `setup` once for its own instance;
 * Agents share no Plugin state.
 */
export interface Plugin<Config = JsonValue> {
  readonly apiVersion: typeof API_VERSION;
  /** Matches `^[a-z][a-z0-9_-]*$` and is not `mcp`. It is the namespace of the Plugin's Tools. */
  readonly name: string;
  readonly version: string;
  /** Wheatley validates the `config` block against it before `setup`. */
  readonly configSchema?: SchemaInput<Config>;
  /**
   * Creates the Plugin's Tools and Frontends for one Agent. A throw or rejection skips the Plugin and reports the error
   * in Agent health; the Agent still starts.
   */
  readonly setup: (
    ctx: PluginSetupContext<Config>
  ) => Promise<PluginContributions> | PluginContributions;
}

/** Returns `plugin` unchanged, typed as a `Plugin` so that config types flow from `configSchema` to `setup`. */
export const definePlugin = <Config = JsonValue>(
  plugin: Plugin<Config>
): Plugin<Config> => plugin;
