import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

import type { Models } from "@earendil-works/pi-ai";
import { PROTOCOL_VERSION } from "@wheatley-ai/protocol";
import type {
  AgentConfig,
  AgentHealth,
  AgentState,
  DaemonStatus,
  DeploymentConfig,
  LogRecord,
  MethodParams,
  MethodResult,
  PendingRestart,
} from "@wheatley-ai/protocol";
import type { SecretReader } from "@wheatley-ai/sdk";

import type {
  ConfigSaveInput,
  ConfigStore,
} from "../contracts/config-store.js";
import { SeamError } from "../contracts/errors.js";
import type { ExtensionCatalog } from "../contracts/extension-catalog.js";
import { systemClock } from "../contracts/module.js";
import type { Clock } from "../contracts/module.js";
import { Agent } from "./agent/agent.js";
import type { AgentOptions, AgentStatus } from "./agent/agent.js";
import { gatedModels } from "./agent/gated-models.js";
import { builtinOnlyCatalog } from "./builtin-catalog.js";
import {
  ConcurrencyGate,
  DEFAULT_PROVIDER_CONCURRENCY,
} from "./concurrency-gate.js";
import { FileConfigStore } from "./config/config-store.js";
import { pendingRestarts } from "./config/pending-restart.js";
import type { AppliedAgent } from "./config/pending-restart.js";
import { EventBus } from "./events.js";
import { LogStore } from "./logger.js";
import { createProviderModels } from "./models.js";
import { Supervisor } from "./supervisor.js";
import type { SetTimer } from "./supervisor.js";

/** The folder of the Agents inside the Deployment home. */
export const AGENTS_DIR = "agents";

/** The folder that `agents.delete` with `data: "archive"` moves Agent folders into. */
export const ARCHIVE_DIR = "archive";

/** Module services that one Agent gets from the Wave 2 wiring, such as the Approval gate and the outbox. */
export type AgentServices = Partial<
  Pick<
    AgentOptions,
    | "approvals"
    | "outbox"
    | "memory"
    | "isDeliverySuppressed"
    | "modules"
    | "migrate"
  >
>;

/** Options of `Deployment.open`. */
export interface DeploymentOptions {
  /** `~/.wheatley/`, or `/data/` in Docker. */
  readonly homeDir: string;
  /** Environment variables, for secret overrides. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The Wheatley version for `system.status`. */
  readonly version: string;
  readonly clock?: Clock;
  /** The Config Store. The default is the `config.yaml` store in `homeDir`. */
  readonly configStore?: ConfigStore;
  /** Builds model access from the config. The default registers every built-in pi-ai provider. */
  readonly models?: (
    config: DeploymentConfig,
    secrets: SecretReader
  ) => Promise<Models>;
  /** The default gives each Agent the built-in Tools only. */
  readonly extensions?: ExtensionCatalog;
  /** The module services of each Agent. */
  readonly agentServices?: (
    agent: string,
    config: AgentConfig
  ) => AgentServices;
  /** Also writes each log record, for example to stderr. */
  readonly writeLog?: (record: LogRecord) => void;
  readonly setTimer?: SetTimer;
}

/** The health fields of an Agent that is not running. */
const IDLE_STATUS: AgentStatus = {
  activeRuns: 0,
  frontends: [],
  mcpServers: [],
  plugins: [],
  skillWarnings: [],
};

const exists = async (target: string): Promise<boolean> => {
  try {
    await stat(target);

    return true;
  } catch {
    return false;
  }
};

/**
 * One running Wheatley installation: the Config Store, the Supervisor of its Agents, the Concurrency Gate, the event
 * bus, and the log buffer (ADR 0001, ADR 0004).
 *
 * Agent lifecycle calls (`createAgent`, `renameAgent`, `deleteAgent`) check `expectedRevision` through the Config Store
 * first and change nothing if it fails.
 */
export class Deployment {
  readonly homeDir: string;
  readonly events = new EventBus();
  readonly logs: LogStore;
  readonly config: ConfigStore;
  readonly gate: ConcurrencyGate;
  readonly #options: DeploymentOptions;
  readonly #clock: Clock;
  readonly #supervisor: Supervisor<Agent>;
  readonly #applied = new Map<string, AppliedAgent>();
  readonly #startedAt: number;
  #current: DeploymentConfig;
  readonly #daemonConfig: DeploymentConfig;

  private constructor(
    options: DeploymentOptions,
    config: ConfigStore,
    initial: DeploymentConfig
  ) {
    this.#options = options;
    this.homeDir = options.homeDir;
    this.config = config;
    this.#clock = options.clock ?? systemClock;
    this.#startedAt = this.#clock.now();
    this.#current = initial;
    this.#daemonConfig = initial;
    this.logs = new LogStore({
      clock: this.#clock,
      events: this.events,
      redact: config.secrets.redact,
      write: options.writeLog,
    });
    this.gate = new ConcurrencyGate(
      (provider) =>
        this.#current.providers?.[provider]?.maxConcurrent ??
        DEFAULT_PROVIDER_CONCURRENCY
    );
    this.#supervisor = new Supervisor<Agent>({
      clock: this.#clock,
      events: this.events,
      log: this.logs.logger("supervisor"),
      open: this.#openAgent,
      setTimer: options.setTimer,
    });
  }

  /**
   * Reads `config.yaml` and creates the Deployment without starting any Agent. Errors: rejects with
   * `SeamError("config_invalid")` if `config.yaml` is invalid.
   */
  static async create(options: DeploymentOptions): Promise<Deployment> {
    const config =
      options.configStore ??
      (await FileConfigStore.open({
        env: options.env,
        homeDir: options.homeDir,
      }));

    const snapshot = await config.read();

    await mkdir(path.join(options.homeDir, AGENTS_DIR), { recursive: true });

    return new Deployment(options, config, snapshot.config);
  }

  /** `create`, then `start`. */
  static async open(options: DeploymentOptions): Promise<Deployment> {
    const deployment = await Deployment.create(options);

    await deployment.start();

    return deployment;
  }

  /**
   * Starts every Agent in `config.yaml`, all at once, and resolves when each is `running` or `degraded`. An Agent that
   * fails to start does not stop the others.
   */
  readonly start = async (): Promise<void> => {
    await Promise.all(
      Object.keys(this.#current.agents).map(
        async (name) => await this.#supervisor.start(name)
      )
    );
  };

  /** The Agent folder of `name`. */
  readonly agentDir = (name: string): string =>
    path.join(this.homeDir, AGENTS_DIR, name);

  /** The names of every Agent that `config.yaml` lists or the Supervisor knows, sorted. */
  get agentNames(): string[] {
    return [
      ...new Set([
        ...Object.keys(this.#current.agents),
        ...this.#supervisor.names,
      ]),
    ].toSorted();
  }

  /** The running Agent `name`. Throws `agent_not_found` for an unknown Agent and `agent_unavailable` otherwise. */
  readonly agent = (name: string): Agent => {
    const state = this.#supervisor.get(name);

    if (state === undefined && this.#current.agents[name] === undefined) {
      throw new SeamError("agent_not_found", `Unknown Agent: ${name}`);
    }

    if (state?.instance === undefined) {
      throw new SeamError(
        "agent_unavailable",
        `Agent ${name} is ${state?.state ?? "stopped"}`
      );
    }

    return state.instance;
  };

  /** Health of one Agent. Throws `SeamError("agent_not_found")`. */
  readonly health = (name: string): AgentHealth => {
    const state = this.#supervisor.get(name);

    if (state === undefined && this.#current.agents[name] === undefined) {
      throw new SeamError("agent_not_found", `Unknown Agent: ${name}`);
    }

    const status = state?.instance?.status() ?? IDLE_STATUS;
    const pending = pendingRestarts(this.#appliedConfig(), this.#current);

    return {
      activeRuns: status.activeRuns,
      frontends: [...status.frontends],
      lastError: state?.lastError ?? null,
      mcpServers: [...status.mcpServers],
      name,
      pendingRestart: pending.some(
        (item) => item.kind !== "daemon" && item.agent === name
      ),
      plugins: [...status.plugins],
      restartBackoffMs: state?.restartBackoffMs ?? null,
      skillWarnings: [...status.skillWarnings],
      state: state?.state ?? "stopped",
    };
  };

  /** Deployment health for `system.status`. */
  readonly status = (): DaemonStatus => {
    const now = this.#clock.now();

    return {
      agents: this.agentNames.map((name) => this.health(name)),
      concurrency: this.gate.pressure(),
      protocolVersion: PROTOCOL_VERSION,
      startedAt: new Date(this.#startedAt).toISOString(),
      uptimeMs: Math.max(0, now - this.#startedAt),
      version: this.#options.version,
    };
  };

  readonly startAgent = async (name: string): Promise<AgentState> => {
    this.#requireConfigured(name);

    return await this.#supervisor.start(name);
  };

  readonly stopAgent = async (name: string): Promise<AgentState> => {
    this.#requireKnown(name);

    return await this.#supervisor.stop(name);
  };

  readonly restartAgent = async (name: string): Promise<AgentState> => {
    this.#requireConfigured(name);

    return await this.#supervisor.restart(name);
  };

  /** `config.get`: the current file, its revision, and the changes that wait for a restart. */
  readonly getConfig = async (): Promise<MethodResult<"config.get">> => {
    const snapshot = await this.config.read();

    this.#current = snapshot.config;

    return {
      config: snapshot.config,
      pendingRestart: pendingRestarts(this.#appliedConfig(), snapshot.config),
      raw: snapshot.raw,
      revision: snapshot.revision,
    };
  };

  /**
   * `config.save`: writes the config, starts Agents that the save added, stops Agents that it removed, and with
   * `restart: "affected"` restarts every Agent with a pending change. Emits `config.changed`.
   */
  readonly saveConfig = async (
    input: ConfigSaveInput,
    expectedRevision: string,
    restart: "none" | "affected"
  ): Promise<MethodResult<"config.save">> => {
    const snapshot = await this.config.save(input, expectedRevision);

    await this.#apply(snapshot.config);

    if (restart === "affected") {
      const affected = new Set(
        pendingRestarts(this.#appliedConfig(), snapshot.config).flatMap(
          (item) => (item.kind === "daemon" ? [] : [item.agent])
        )
      );

      await Promise.all(
        [...affected].map(async (name) => await this.#supervisor.restart(name))
      );
    }

    return this.#changed(snapshot.revision);
  };

  /** `agents.create`: adds the Agent to `config.yaml` and starts it. Throws `conflict` for an existing name. */
  readonly createAgent = async (
    name: string,
    config: AgentConfig,
    expectedRevision: string
  ): Promise<MethodResult<"agents.create">> => {
    const current = await this.config.read();

    if (
      current.config.agents[name] !== undefined ||
      this.#supervisor.get(name) !== undefined
    ) {
      throw new SeamError("conflict", `Agent ${name} already exists`);
    }

    const snapshot = await this.config.save(
      {
        config: {
          ...current.config,
          agents: { ...current.config.agents, [name]: config },
        },
      },
      expectedRevision
    );

    await this.#apply(snapshot.config);

    return { revision: this.#changed(snapshot.revision).revision };
  };

  /**
   * `agents.rename`: stops the Agent, moves its folder, renames it in `config.yaml`, and starts it under the new name.
   * If the config write fails, it moves the folder back and starts the Agent under its old name.
   */
  readonly renameAgent = async (
    name: string,
    newName: string,
    expectedRevision: string
  ): Promise<MethodResult<"agents.rename">> => {
    const current = await this.config.read();
    const agentConfig = current.config.agents[name];

    if (agentConfig === undefined) {
      throw new SeamError("agent_not_found", `Unknown Agent: ${name}`);
    }

    if (
      current.config.agents[newName] !== undefined ||
      (await exists(this.agentDir(newName)))
    ) {
      throw new SeamError("conflict", `Agent ${newName} already exists`);
    }

    if (current.revision !== expectedRevision) {
      throw new SeamError(
        "revision_conflict",
        "config.yaml changed since it was read",
        {
          revision: current.revision,
        }
      );
    }

    const agents = Object.fromEntries(
      Object.entries(current.config.agents).map(([key, value]) => [
        key === name ? newName : key,
        value,
      ])
    );

    await this.#supervisor.remove(name);
    this.#applied.delete(name);

    const moved = await exists(this.agentDir(name));

    if (moved) {
      await rename(this.agentDir(name), this.agentDir(newName));
    }

    try {
      const snapshot = await this.config.save(
        { config: { ...current.config, agents } },
        expectedRevision
      );

      await this.#apply(snapshot.config);

      return { revision: this.#changed(snapshot.revision).revision };
    } catch (error) {
      if (moved) {
        await rename(this.agentDir(newName), this.agentDir(name));
      }

      await this.#supervisor.start(name);
      throw error;
    }
  };

  /** `agents.delete`: removes the Agent from `config.yaml`, stops it, and keeps, archives, or deletes its folder. */
  readonly deleteAgent = async (
    params: MethodParams<"agents.delete">
  ): Promise<MethodResult<"agents.delete">> => {
    const current = await this.config.read();

    if (current.config.agents[params.agent] === undefined) {
      throw new SeamError("agent_not_found", `Unknown Agent: ${params.agent}`);
    }

    const agents = Object.fromEntries(
      Object.entries(current.config.agents).filter(
        ([key]) => key !== params.agent
      )
    );

    const snapshot = await this.config.save(
      { config: { ...current.config, agents } },
      params.expectedRevision
    );

    await this.#apply(snapshot.config);

    const dir = this.agentDir(params.agent);

    if (params.data === "delete") {
      await rm(dir, { force: true, recursive: true });
    } else if (params.data === "archive" && (await exists(dir))) {
      const stamp = new Date(this.#clock.now())
        .toISOString()
        .replaceAll(":", "-");

      const archiveDir = path.join(this.homeDir, ARCHIVE_DIR);

      await mkdir(archiveDir, { recursive: true });
      await rename(dir, path.join(archiveDir, `${params.agent}-${stamp}`));
    }

    return { revision: this.#changed(snapshot.revision).revision };
  };

  /** Stops every Agent. */
  readonly close = async (): Promise<void> => {
    await this.#supervisor.stopAll();
  };

  readonly #requireKnown = (name: string): void => {
    if (
      this.#supervisor.get(name) === undefined &&
      this.#current.agents[name] === undefined
    ) {
      throw new SeamError("agent_not_found", `Unknown Agent: ${name}`);
    }
  };

  readonly #requireConfigured = (name: string): void => {
    if (this.#current.agents[name] === undefined) {
      throw new SeamError("agent_not_found", `Unknown Agent: ${name}`);
    }
  };

  /** Starts Agents that `config` added and stops Agents that it removed. */
  readonly #apply = async (config: DeploymentConfig): Promise<void> => {
    this.#current = config;

    const removed = this.#supervisor.names.filter(
      (name) => config.agents[name] === undefined
    );

    const added = Object.keys(config.agents).filter(
      (name) => this.#supervisor.get(name) === undefined
    );

    await Promise.all(
      removed.map(async (name) => {
        await this.#supervisor.remove(name);
        this.#applied.delete(name);
      })
    );
    await Promise.all(
      added.map(async (name) => await this.#supervisor.start(name))
    );
  };

  readonly #changed = (revision: string): MethodResult<"config.save"> => {
    const pendingRestart: PendingRestart[] = pendingRestarts(
      this.#appliedConfig(),
      this.#current
    );

    this.events.emit("config.changed", { pendingRestart, revision });

    return { pendingRestart, revision };
  };

  readonly #appliedConfig = () => ({
    agents: new Map(
      [...this.#applied.entries()].filter(
        ([name]) => this.#supervisor.get(name)?.instance !== undefined
      )
    ),
    daemon: this.#daemonConfig,
  });

  readonly #openAgent = async (
    name: string,
    controls: Pick<AgentOptions, "onFailed" | "onRestartRequested">
  ): Promise<Agent> => {
    const snapshot = await this.config.read();

    this.#current = snapshot.config;

    const config = snapshot.config.agents[name];

    if (config === undefined) {
      throw new SeamError("agent_not_found", `Unknown Agent: ${name}`);
    }

    const providers = snapshot.config.providers ?? {};
    const createModels = this.#options.models ?? createProviderModels;
    const base = await createModels(snapshot.config, this.config.secrets);

    const models = gatedModels(
      base,
      this.gate,
      (provider) => this.#current.providers?.[provider]?.baseUrl
    );

    const agent = await Agent.open({
      ...this.#options.agentServices?.(name, config),
      agentDir: this.agentDir(name),
      clock: this.#clock,
      config,
      events: this.events,
      extensions: this.#options.extensions ?? builtinOnlyCatalog,
      homeDir: this.homeDir,
      log: this.logs.logger("agent", name),
      models,
      name,
      onFailed: controls.onFailed,
      onRestartRequested: controls.onRestartRequested,
      secrets: this.config.secrets,
    });

    this.#applied.set(name, {
      config,
      provider: providers[config.model.provider],
    });

    return agent;
  };
}
