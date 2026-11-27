import { homedir } from "node:os";

import { Argument, Option } from "commander";
import type { Command } from "commander";

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

/** The parsed options of a subcommand that declares none. */
type NoOptions = Readonly<Record<string, never>>;

const SERVICE_ACTIONS = [
  "install",
  "start",
  "stop",
  "restart",
  "status",
] as const;

/** Runs `body` and turns a thrown error into exit code 1 and a line on `io.err`, so that a command never rejects. */
const guarded = async (
  io: CliIo,
  body: () => Promise<number>
): Promise<number> => {
  try {
    return await body();
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));

    return EXIT_FAILURE;
  }
};

const serviceCommand = async (
  deps: OpsCliDeps,
  io: CliIo,
  action: string
): Promise<number> => {
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
      throw new Error(`Unknown service action: ${action}`);
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

/** The options of `wheatley update`. */
interface UpdateOptions {
  readonly check?: boolean;
  readonly method?: string;
}

const updateCommand = async (
  deps: OpsCliDeps,
  io: CliIo,
  values: UpdateOptions
): Promise<number> => {
  if (values.method !== undefined && !isUpdateMethod(values.method)) {
    throw new Error(`Unknown install method: ${values.method}`);
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

const restoreCommand = async (
  deps: OpsCliDeps,
  io: CliIo,
  agent: string,
  backup: string | undefined
): Promise<number> => {
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

/** What the ops subcommands of `addOpsCommands` need from the CLI root. */
export interface OpsCommandHost {
  /** The dependencies for one parsed subcommand, for example with the Deployment home of its `--home`. */
  readonly deps: (command: Command) => OpsCliDeps;
  readonly io: CliIo;
  /** Receives the exit code of the subcommand: 0 for success and 1 for a failure. */
  readonly exit: (code: number) => void;
}

/**
 * Adds `service`, `update`, and `restore` to `program`. Call it after the root options and the output, help, and
 * exit settings of `program`, because subcommands copy those settings when they are created.
 *
 * - `wheatley service <install|start|stop|restart|status>`
 * - `wheatley update [--check] [--method npm|pnpm|yarn|bun|brew|curl]`
 * - `wheatley restore <agent> [backup]`: without `backup`, it lists the Agent's backups on stdout. With `backup`, it
 *   restores that backup. A running daemon, an invalid Agent name, or a failed restore prints the error on stderr and
 *   exits 1.
 *
 * Commander reports usage errors, for example a missing Agent name or an unknown option, before an action runs.
 */
export const addOpsCommands = (
  program: Command,
  host: OpsCommandHost
): void => {
  const run = async (
    command: Command,
    body: (deps: OpsCliDeps) => Promise<number>
  ): Promise<void> => {
    host.exit(
      await guarded(host.io, async () => await body(host.deps(command)))
    );
  };

  program
    .command("service")
    .description(
      "Install or control the Wheatley service: install, start, stop, restart, status"
    )
    .addArgument(
      new Argument("<action>", "The service action").choices(SERVICE_ACTIONS)
    )
    .action(async (action: string, _options: NoOptions, command: Command) => {
      await run(
        command,
        async (deps) => await serviceCommand(deps, host.io, action)
      );
    });

  program
    .command("update")
    .description("Update Wheatley within its major version")
    .option("--check", "Report an available update and install nothing")
    .addOption(
      new Option(
        "--method <method>",
        "The install method of this Wheatley"
      ).choices(UPDATE_METHODS)
    )
    .action(async (options: UpdateOptions, command: Command) => {
      await run(
        command,
        async (deps) => await updateCommand(deps, host.io, options)
      );
    });

  program
    .command("restore")
    .description("List the backups of an Agent, or restore its agent.sqlite")
    .argument("<agent>", "The Agent name")
    .argument("[backup]", "The backup file to restore")
    .action(
      async (
        agent: string,
        backup: string | undefined,
        _options: NoOptions,
        command: Command
      ) => {
        await run(
          command,
          async (deps) => await restoreCommand(deps, host.io, agent, backup)
        );
      }
    );
};
