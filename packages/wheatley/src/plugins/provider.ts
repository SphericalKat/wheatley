import { mkdir } from "node:fs/promises";
import path from "node:path";

import { isJsonValue } from "@wheatley-ai/protocol";
import type {
  ExtensionStatus,
  JsonValue,
  PluginConfig,
} from "@wheatley-ai/protocol";
import type {
  Frontend,
  Logger,
  PluginContributions,
  ToolContext,
  ToolResult,
} from "@wheatley-ai/sdk";

import type {
  PluginProvider,
  ProviderInput,
  ToolDescriptor,
} from "../contracts/extension-catalog.js";
import { disposerOf, loadContributions } from "./contributions.js";
import type { Contributions, LoadedTool } from "./contributions.js";
import { errorMessage, isToolResult } from "./guards.js";
import { importPlugin } from "./load.js";
import type { PluginDefinition } from "./load.js";
import type { SchemaCheck } from "./schema.js";

/** The default time limit of one Plugin `setup` call. */
export const DEFAULT_SETUP_TIMEOUT_MS = 30_000;

/** The default time limit of one Plugin `dispose` call. */
export const DEFAULT_DISPOSE_TIMEOUT_MS = 10_000;

/** The folder of the Agent directory that holds one private data folder per Plugin. */
export const PLUGIN_DATA_DIR = "plugins";

const AGENT_STOPPED = "The Agent stopped while the Plugin loaded";

/** Limits of a Plugin provider. Tests shorten them. */
export interface PluginProviderOptions {
  /** The time limit of one Plugin `setup` call. A Plugin that exceeds it fails to load. */
  readonly setupTimeoutMs?: number;
  /** The time limit of one Plugin `dispose` call on `close`. */
  readonly disposeTimeoutMs?: number;
}

/** A Plugin that loaded and contributes Tools and Frontends. */
interface LoadedPlugin {
  readonly name: string;
  readonly contributions: Contributions;
}

/** The load outcome of one `plugins` entry of the Agent config. */
interface EntryOutcome {
  readonly status: ExtensionStatus;
  readonly plugin?: LoadedPlugin;
}

/** One `plugins` entry after its module imported and validated. */
type Prepared =
  | { readonly kind: "done"; readonly outcome: EntryOutcome }
  | {
      readonly kind: "defined";
      readonly entry: PluginConfig;
      readonly definition: PluginDefinition;
    };

/** A Tool result that reports `text` as an error to the model. */
const toolErrorResult = (text: string): ToolResult => ({
  content: [{ text, type: "text" }],
  isError: true,
});

const failed = (name: string, error: string): EntryOutcome => ({
  status: { error, name, state: "failed" },
});

const stopped = (name: string): EntryOutcome => ({
  status: { error: AGENT_STOPPED, name, state: "stopped" },
});

/**
 * Settles with `work`, or rejects when `signal` aborts first. The abort reason becomes the rejection. Removes its
 * listener when it settles.
 */
const raceAbort = async <T>(
  work: Promise<T>,
  signal: AbortSignal
): Promise<T> => {
  signal.throwIfAborted();

  const { promise: aborted, reject } = Promise.withResolvers<never>();

  const onAbort = (): void => {
    reject(signal.reason);
  };

  signal.addEventListener("abort", onAbort, { once: true });

  try {
    return await Promise.race([work, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
};

/** Starts `call` on a later microtask, so a synchronous throw becomes a rejection. */
const deferCall = async <T>(call: () => T): Promise<Awaited<T>> => {
  await Promise.resolve();

  return await call();
};

const pluginLogger = (log: Logger, plugin: string): Logger => ({
  debug: (message, fields) => {
    log.debug(message, { ...fields, plugin });
  },
  error: (message, fields) => {
    log.error(message, { ...fields, plugin });
  },
  info: (message, fields) => {
    log.info(message, { ...fields, plugin });
  },
  warn: (message, fields) => {
    log.warn(message, { ...fields, plugin });
  },
});

const prepareEntry = async (
  entry: PluginConfig,
  homeDir: string
): Promise<Prepared> => {
  if (entry.enabled === false) {
    return {
      kind: "done",
      outcome: { status: { name: entry.source, state: "disabled" } },
    };
  }

  try {
    const definition = await importPlugin(entry.source, homeDir);

    return { definition, entry, kind: "defined" };
  } catch (error) {
    return { kind: "done", outcome: failed(entry.source, errorMessage(error)) };
  }
};

/** Validates the `config` block of `entry` against the Plugin's `configSchema`. A missing block counts as `{}`. */
const checkPluginConfig = async (
  definition: PluginDefinition,
  entry: PluginConfig
): Promise<SchemaCheck> => {
  const config = entry.config ?? {};

  if (!isJsonValue(config)) {
    return { message: "the config block is not JSON", ok: false };
  }

  return (
    (await definition.configSchema?.check(config)) ?? {
      ok: true,
      value: config,
    }
  );
};

/** Calls one Plugin's `dispose` with a time limit. Logs and swallows its errors. */
const disposePlugin = async (
  name: string,
  dispose: () => Promise<void>,
  log: Logger,
  options: Required<PluginProviderOptions>
): Promise<void> => {
  try {
    await raceAbort(
      deferCall(dispose),
      AbortSignal.timeout(options.disposeTimeoutMs)
    );
  } catch (error) {
    log.warn("Plugin dispose failed", {
      error: errorMessage(error),
      plugin: name,
    });
  }
};

/**
 * Waits for a `setup` call that lost the race against its time limit or the Agent stop, and disposes what it returns
 * late. Logs and swallows a late rejection.
 */
const disposeLate = async (
  pending: Promise<PluginContributions>,
  log: Logger
): Promise<void> => {
  try {
    await disposerOf(await pending)();
  } catch (error) {
    log.debug("Plugin setup failed after its time limit or the Agent stop", {
      error: errorMessage(error),
    });
  }
};

/** Waits for one late disposal up to the dispose time limit. Logs and swallows a timeout. */
const disposeWithin = async (
  late: Promise<void>,
  log: Logger,
  options: Required<PluginProviderOptions>
): Promise<void> => {
  try {
    await raceAbort(late, AbortSignal.timeout(options.disposeTimeoutMs));
  } catch (error) {
    log.warn("A late Plugin setup did not finish before close", {
      error: errorMessage(error),
    });
  }
};

const setupTimeoutMessage = (
  options: Required<PluginProviderOptions>
): string => `Plugin setup timed out after ${options.setupTimeoutMs} ms`;

interface SetupInput {
  readonly provider: ProviderInput;
  readonly options: Required<PluginProviderOptions>;
  /** The disposals of `setup` calls that finished late. `close` waits for them, up to the dispose time limit. */
  readonly lateDisposals: Promise<void>[];
}

/**
 * Calls `setup` of one Plugin with a time limit and validates what it returns. If `setup` resolves after the time
 * limit or after the Agent stopped, the late contributions are disposed.
 */
const setupPlugin = async (
  definition: PluginDefinition,
  entry: PluginConfig,
  { provider, options, lateDisposals }: SetupInput
): Promise<EntryOutcome> => {
  const { name } = definition.plugin;
  const log = pluginLogger(provider.log, name);
  const config = await checkPluginConfig(definition, entry);

  if (!config.ok) {
    return failed(name, `Invalid Plugin config: ${config.message}`);
  }

  const controller = new AbortController();
  const { signal } = controller;

  const onStop = (): void => {
    controller.abort(provider.signal.reason);
  };

  const timer = setTimeout(() => {
    controller.abort(new Error(setupTimeoutMessage(options)));
  }, options.setupTimeoutMs);

  const dataDir = path.join(provider.agentDir, PLUGIN_DATA_DIR, name);
  let returned: PluginContributions;

  provider.signal.addEventListener("abort", onStop, { once: true });

  try {
    await mkdir(dataDir, { recursive: true });

    const pending = deferCall(
      async () =>
        await definition.plugin.setup({
          agentName: provider.agentName,
          config: config.value,
          dataDir,
          log,
          secrets: provider.secrets,
          signal,
        })
    );

    try {
      returned = await raceAbort(pending, signal);
    } catch (error) {
      if (signal.aborted) {
        lateDisposals.push(disposeLate(pending, log));
      }

      throw error;
    }
  } catch (error) {
    if (provider.signal.aborted) {
      return stopped(name);
    }

    return failed(
      name,
      signal.aborted
        ? setupTimeoutMessage(options)
        : `Plugin setup failed: ${errorMessage(error)}`
    );
  } finally {
    clearTimeout(timer);
    provider.signal.removeEventListener("abort", onStop);
  }

  try {
    const contributions = loadContributions(name, returned);

    return {
      plugin: { contributions, name },
      status: { name, state: "ready" },
    };
  } catch (error) {
    await disposePlugin(name, disposerOf(returned), provider.log, options);

    return failed(name, errorMessage(error));
  }
};

/** Fails the later of two Plugin entries with the same Plugin name, in config order. */
const dedupeNames = (prepared: readonly Prepared[]): Prepared[] => {
  const seen = new Set<string>();

  return prepared.map((item) => {
    if (item.kind === "done") {
      return item;
    }

    const { name } = item.definition.plugin;

    if (seen.has(name)) {
      return {
        kind: "done",
        outcome: failed(
          name,
          `Another plugins entry already loaded a Plugin named ${name} (source ${item.entry.source})`
        ),
      };
    }

    seen.add(name);

    return item;
  });
};

/** Fails a later Plugin that contributes a Frontend `type` that an earlier Plugin contributes, in config order. */
const dedupeFrontends = async (
  outcomes: readonly EntryOutcome[],
  input: SetupInput
): Promise<EntryOutcome[]> => {
  const owners = new Map<string, string>();
  const rejected: LoadedPlugin[] = [];
  const result: EntryOutcome[] = [];

  for (const outcome of outcomes) {
    const { plugin } = outcome;

    if (plugin === undefined) {
      result.push(outcome);
      continue;
    }

    const { frontends } = plugin.contributions;

    const taken = frontends
      .map(({ type }) => ({ owner: owners.get(type), type }))
      .find(({ owner }) => owner !== undefined);

    if (taken?.owner !== undefined) {
      rejected.push(plugin);
      result.push(
        failed(
          plugin.name,
          `Plugin ${taken.owner} already contributes the Frontend type ${taken.type}`
        )
      );
      continue;
    }

    for (const { type } of frontends) {
      owners.set(type, plugin.name);
    }

    result.push(outcome);
  }

  await Promise.all(
    rejected.map(async ({ name, contributions }) => {
      await disposePlugin(
        name,
        contributions.dispose,
        input.provider.log,
        input.options
      );
    })
  );

  return result;
};

const loadEntries = async (input: SetupInput): Promise<EntryOutcome[]> => {
  const entries = input.provider.config.plugins ?? [];

  const prepared = dedupeNames(
    await Promise.all(
      entries.map(
        async (entry) => await prepareEntry(entry, input.provider.homeDir)
      )
    )
  );

  const outcomes = await Promise.all(
    prepared.map(async (item) => {
      if (item.kind === "done") {
        return item.outcome;
      }

      if (input.provider.signal.aborted) {
        return stopped(item.definition.plugin.name);
      }

      return await setupPlugin(item.definition, item.entry, input);
    })
  );

  return await dedupeFrontends(outcomes, input);
};

const runTool = async (
  tool: LoadedTool,
  input: JsonValue,
  ctx: ToolContext
): Promise<ToolResult> => {
  const { name } = tool.descriptor;
  const checked = await raceAbort(tool.schema.check(input), ctx.signal);

  if (!checked.ok) {
    return toolErrorResult(`Invalid input for ${name}: ${checked.message}`);
  }

  const result = await raceAbort(
    deferCall(async () => await tool.tool.execute(checked.value, ctx)),
    ctx.signal
  );

  return isToolResult(result)
    ? result
    : toolErrorResult(`${name} returned a result that is not a ToolResult`);
};

/**
 * Loads the Plugins of one Agent from `input.config.plugins` and returns the `PluginProvider` over them (ADR 0006).
 *
 * Loading:
 * - Each entry with `enabled: false` reports `disabled` under its `source` and does not import.
 * - The provider imports every other entry (see `resolvePluginUrl`) and validates the default export against the
 *   `Plugin` contract, including the integer `apiVersion: 1`. Imports run in parallel.
 * - It validates the entry's `config` block (`{}` if absent) against `configSchema`, creates the data folder
 *   `<agentDir>/plugins/<name>/`, and calls `setup` with a time limit. Setups run in parallel.
 * - It names each Tool `<plugin>:<tool>` and collects Frontends by `type`. If two entries load the same Plugin name or
 *   contribute the same Frontend `type`, the later entry in config order fails.
 *
 * Invariants: one broken Plugin never rejects this function and never removes another Plugin. It contributes no Tools
 * or Frontends, and `health` reports it as `failed` with its error under its Plugin name, or under its `source` if the
 * module did not load. `health` lists the entries in config order. If `input.signal` aborts during loading, the
 * Plugins that did not finish report `stopped`.
 *
 * `close` runs once. It disposes every loaded Plugin and each `setup` that finished after its time limit or the Agent
 * stop, and waits up to the dispose time limit for each.
 *
 * Errors: rejects only for defects in the provider itself.
 */
export const createPluginProvider = async (
  input: ProviderInput,
  options: PluginProviderOptions = {}
): Promise<PluginProvider> => {
  const limits: Required<PluginProviderOptions> = {
    disposeTimeoutMs: options.disposeTimeoutMs ?? DEFAULT_DISPOSE_TIMEOUT_MS,
    setupTimeoutMs: options.setupTimeoutMs ?? DEFAULT_SETUP_TIMEOUT_MS,
  };

  const lateDisposals: Promise<void>[] = [];

  const outcomes = await loadEntries({
    lateDisposals,
    options: limits,
    provider: input,
  });

  for (const { status } of outcomes) {
    if (status.state === "failed") {
      input.log.warn("Plugin failed to load", {
        error: status.error ?? "",
        plugin: status.name,
      });
    }
  }

  const plugins = outcomes.flatMap(({ plugin }) =>
    plugin === undefined ? [] : [plugin]
  );

  const tools = new Map(
    plugins.flatMap(({ contributions }) =>
      contributions.tools.map((tool) => [tool.descriptor.name, tool] as const)
    )
  );

  const frontends = plugins.flatMap(
    ({ contributions }) => contributions.frontends
  );

  let statuses: readonly ExtensionStatus[] = outcomes.map(
    ({ status }) => status
  );

  let closing: Promise<void> | undefined;

  const close = async (): Promise<void> => {
    closing ??= (async () => {
      statuses = statuses.map((status) =>
        status.state === "ready"
          ? { name: status.name, state: "stopped" }
          : status
      );
      await Promise.all([
        ...plugins.map(async ({ name, contributions }) => {
          await disposePlugin(name, contributions.dispose, input.log, limits);
        }),
        ...lateDisposals.map(async (late) => {
          await disposeWithin(late, input.log, limits);
        }),
      ]);
    })();

    await closing;
  };

  return {
    close,
    execute: async (name, toolInput, ctx) => {
      const tool = closing === undefined ? tools.get(name) : undefined;

      if (tool === undefined) {
        return toolErrorResult(`Unknown Tool: ${name}`);
      }

      try {
        return await runTool(tool, toolInput, ctx);
      } catch (error) {
        return ctx.signal.aborted
          ? toolErrorResult(`${name} was aborted`)
          : toolErrorResult(`${name} failed: ${errorMessage(error)}`);
      }
    },
    frontends: (): readonly Frontend[] =>
      closing === undefined ? frontends : [],
    health: () => statuses,
    tools: (): readonly ToolDescriptor[] =>
      closing === undefined
        ? [...tools.values()].map((tool) => tool.descriptor)
        : [],
  };
};
