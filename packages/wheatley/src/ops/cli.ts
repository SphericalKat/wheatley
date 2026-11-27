import { homedir } from "node:os";
import { parseArgs } from "node:util";

import { systemClock } from "../contracts/module.js";
import type { Clock } from "../contracts/module.js";
import { listBackups, restoreAgentBackup } from "./backup.js";
import { processRunner } from "./command-runner.js";
import { resolveInstallation, UPDATE_METHODS } from "./install-method.js";
import type { UpdateMethod } from "./install-method.js";
import { agentDirFor, resolveHomeDir } from "./paths.js";
import type { FetchFn } from "./registry.js";
import {
  createServiceManager,
  packageBinScript,
  resolveServiceSpec,
} from "./service.js";
import type { ServiceManagerOptions } from "./service.js";
import {
  applyUpgrade,
  packageDir,
  planUpdate,
  readPackageVersion,
} from "./update.js";
import type { NewerMajor } from "./update.js";

/** Output streams of one CLI command. */
export interface CliIo {
  /** Writes one line of normal output, for example to stdout. `line` has no line break at the end. */
  readonly out: (line: string) => void;
  /** Writes one line of error or usage output, for example to stderr. `line` has no line break at the end. */
  readonly err: (line: string) => void;
}

/**
 * One `wheatley` subcommand. `args` are the arguments after the subcommand name. Resolves with the process exit code:
 * 0 for success, 1 for a failure, and 2 for a usage error. It never rejects: it writes errors to `io.err`.
 */
export type CliCommand = (
  args: readonly string[],
  io: CliIo
) => Promise<number>;

/** What the ops CLI commands need from the host. */
export interface OpsCliDeps extends ServiceManagerOptions {
  /** The Wheatley home folder. It must equal `DeploymentModuleContext.homeDir` of the daemon: use `resolveHomeDir`. */
  readonly homeDir: string;
  /** The Node.js binary that runs the CLI. */
  readonly execPath: string;
  /** The package folder of the running Wheatley, which `wheatley update` inspects and checks. */
  readonly packageDir: string;
  /** Queries the npm registry for `wheatley update`. */
  readonly fetch: FetchFn;
  readonly clock: Clock;
  /**
   * Resolves `true` if a daemon runs for the Wheatley home folder. `wheatley restore` refuses to replace
   * `agent.sqlite` then, because the daemon holds it open.
   */
  readonly isDaemonRunning: () => Promise<boolean>;
  /** The configured `daemon.drainTimeout` in milliseconds, for the service stop grace period. */
  readonly drainTimeoutMs?: number;
}

/** The ops CLI dependencies of this process. */
export const hostCliDeps = (
  isDaemonRunning: () => Promise<boolean>,
  drainTimeoutMs?: number
): OpsCliDeps => ({
  clock: systemClock,
  env: process.env,
  execPath: process.execPath,
  fetch: globalThis.fetch,
  homeDir: resolveHomeDir(),
  isDaemonRunning,
  packageDir: packageDir(),
  platform: process.platform,
  runner: processRunner,
  uid: process.getuid?.() ?? 0,
  userHome: homedir(),
  drainTimeoutMs,
});

const EXIT_OK = 0;
const EXIT_FAILURE = 1;
const EXIT_USAGE = 2;

const SERVICE_USAGE =
  "Usage: wheatley service <install|start|stop|restart|status>";

const UPDATE_USAGE = `Usage: wheatley update [--check] [--method ${UPDATE_METHODS.join("|")}]`;
const RESTORE_USAGE = "Usage: wheatley restore <agent> [backup]";

class UsageError extends Error {
  override readonly name = "UsageError";
}

const isUsageError = (error: Error): boolean =>
  error instanceof UsageError ||
  ("code" in error && String(error.code).startsWith("ERR_PARSE_ARGS"));

/** Turns thrown errors into exit codes, so that a command never rejects. */
const guarded =
  (usage: string, body: CliCommand): CliCommand =>
  async (args, io) => {
    try {
      return await body(args, io);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      io.err(failure.message);

      if (isUsageError(failure)) {
        io.err(usage);

        return EXIT_USAGE;
      }

      return EXIT_FAILURE;
    }
  };

const serviceCommand =
  (deps: OpsCliDeps): CliCommand =>
  async (args, io) => {
    const { positionals } = parseArgs({
      allowPositionals: true,
      args: [...args],
    });

    const [action, ...extra] = positionals;

    if (action === undefined || extra.length > 0) {
      throw new UsageError("Pass exactly one service action.");
    }

    const manager = createServiceManager(deps);

    switch (action) {
      case "install": {
        const spec = await resolveServiceSpec({
          binScript: packageBinScript(),
          env: deps.env,
          execPath: deps.execPath,
          homeDir: deps.homeDir,
          drainTimeoutMs: deps.drainTimeoutMs,
        });

        const result = await manager.install(spec);
        io.out(`Installed the ${manager.kind} unit: ${result.unitPath}`);

        for (const note of result.notes) {
          io.out(note);
        }

        return EXIT_OK;
      }

      case "start": {
        await manager.start();
        io.out("Started the Wheatley service.");

        return EXIT_OK;
      }

      case "stop": {
        await manager.stop();
        io.out("Stopped the Wheatley service.");

        return EXIT_OK;
      }

      case "restart": {
        await manager.restart();
        io.out("Restarted the Wheatley service.");

        return EXIT_OK;
      }

      case "status": {
        const status = await manager.status();
        io.out(`Manager: ${status.manager}`);
        io.out(`Unit: ${status.unitPath}`);
        io.out(`State: ${status.state}`);
        io.out(`PID: ${status.pid ?? "-"}`);

        return EXIT_OK;
      }

      default: {
        throw new UsageError(`Unknown service action: ${action}`);
      }
    }
  };

const isUpdateMethod = (value: string): value is UpdateMethod =>
  UPDATE_METHODS.some((method) => method === value);

const newerMajorLines = (major: NewerMajor): string[] => {
  const intro = `Wheatley ${major.version} is a new major version. wheatley update stays within the current major version. Read the release notes, then`;

  return major.action.kind === "command"
    ? [`${intro} run: ${major.action.command.join(" ")}`]
    : [`${intro}:`, ...major.action.lines];
};

const updateCommand =
  (deps: OpsCliDeps): CliCommand =>
  async (args, io) => {
    const { values } = parseArgs({
      args: [...args],
      options: {
        check: { type: "boolean" },
        method: { type: "string" },
      },
    });

    if (values.method !== undefined && !isUpdateMethod(values.method)) {
      throw new UsageError(`Unknown install method: ${values.method}`);
    }

    const installation = await resolveInstallation({
      env: deps.env,
      execPath: deps.execPath,
      method: values.method,
      packageDir: deps.packageDir,
      platform: deps.platform,
      runner: deps.runner,
      userHome: deps.userHome,
    });

    const plan = await planUpdate({
      current: await readPackageVersion(installation.packageDir),
      env: deps.env,
      fetch: deps.fetch,
      installation,
    });

    if (plan.kind === "docker") {
      io.out(
        "This Wheatley runs in Docker. In the folder of docker-compose.yml, run:"
      );

      for (const command of plan.commands) {
        io.out(`  ${command}`);
      }

      return EXIT_OK;
    }

    const newerMajor =
      plan.newerMajor === undefined ? [] : newerMajorLines(plan.newerMajor);

    if (plan.kind === "up_to_date") {
      io.out(
        `Wheatley ${plan.current} is the newest release of its major version.`
      );
    } else if (plan.action.kind === "notice") {
      io.out(
        `Wheatley ${plan.target} is available. This Wheatley runs ${plan.current}.`
      );

      for (const line of plan.action.lines) {
        io.out(line);
      }
    } else if (values.check === true) {
      io.out(
        `Update available: ${plan.current} -> ${plan.target}. Run: wheatley update`
      );
    } else {
      io.out(
        `Updating Wheatley ${plan.current} -> ${plan.target}: ${plan.action.command.join(" ")}`
      );
      await applyUpgrade(plan.action, {
        packageDir: installation.packageDir,
        runner: deps.runner,
        target: plan.target,
        workDir: deps.userHome,
      });
      io.out(
        `Updated Wheatley to ${plan.target}. If the daemon runs as a service, run: wheatley service restart`
      );
    }

    for (const line of newerMajor) {
      io.out(line);
    }

    return EXIT_OK;
  };

const restoreCommand =
  (deps: OpsCliDeps): CliCommand =>
  async (args, io) => {
    const { positionals } = parseArgs({
      allowPositionals: true,
      args: [...args],
    });

    const [agent, backup, ...extra] = positionals;

    if (agent === undefined || extra.length > 0) {
      throw new UsageError("Pass an Agent name and at most one backup.");
    }

    const agentDir = agentDirFor(deps.homeDir, agent);

    if (backup === undefined) {
      const backups = await listBackups(agentDir);
      io.out(
        backups.length === 0
          ? `Agent ${agent} has no backups.`
          : `Backups of Agent ${agent}, newest first:`
      );

      for (const info of backups) {
        io.out(`  ${info.file}  (${info.reason}, ${info.createdAt})`);
      }

      return EXIT_OK;
    }

    if (await deps.isDaemonRunning()) {
      io.err(
        "The Wheatley daemon is running and holds agent.sqlite open. Stop it first, for example: wheatley service stop"
      );

      return EXIT_FAILURE;
    }

    const result = await restoreAgentBackup({
      agentDir,
      backup,
      clock: deps.clock,
    });

    io.out(`Restored Agent ${agent} from ${result.restoredFrom}.`);

    if (result.safetyBackup !== undefined) {
      io.out(
        `The replaced agent.sqlite is in backup ${result.safetyBackup.file}.`
      );
    }

    return EXIT_OK;
  };

/** The ops subcommands, by name, for the CLI root. */
export interface OpsCommands {
  /** `wheatley service <install|start|stop|restart|status>` */
  readonly service: CliCommand;
  /** `wheatley update [--check] [--method npm|pnpm|yarn|bun|brew|curl]` */
  readonly update: CliCommand;
  /**
   * `wheatley restore <agent> [backup]`
   *
   * - Without `backup`, it lists the Agent's backups on stdout and exits 0.
   * - With `backup`, it restores that backup and exits 0.
   * - A missing Agent name, an extra argument, or an unknown option prints the usage on stderr and exits 2.
   * - A running daemon, an invalid Agent name, or a failed restore prints the error on stderr and exits 1.
   */
  readonly restore: CliCommand;
}

/** Creates the ops subcommand handlers. */
export const createOpsCommands = (deps: OpsCliDeps): OpsCommands => ({
  restore: guarded(RESTORE_USAGE, restoreCommand(deps)),
  service: guarded(SERVICE_USAGE, serviceCommand(deps)),
  update: guarded(UPDATE_USAGE, updateCommand(deps)),
});
