import {
  access,
  constants,
  mkdir,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describeFailure } from "./command-runner.js";
import type { CommandResult, CommandRunner } from "./command-runner.js";
import { DOCKER_ENV, HOME_ENV } from "./paths.js";

/** How long the daemon waits for active Runs after `SIGTERM` before it stops them, unless config sets `daemon.drainTimeout`. */
export const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;

/** How long the service manager waits after `SIGTERM` before it sends `SIGKILL`. */
export const STOP_GRACE_MS = 45_000;

/** The time that the daemon gets after the drain to close storage and child processes. */
const SHUTDOWN_MARGIN_MS = 15_000;

const MS_PER_SECOND = 1000;

/** The CLI subcommand that runs the daemon in the foreground. The service units start it. */
export const DAEMON_SUBCOMMAND = "daemon";

export const SYSTEMD_UNIT_NAME = "wheatley.service";
export const LAUNCHD_LABEL = "wheatley.daemon";

/** What a service unit starts. */
export interface ServiceSpec {
  /** The absolute program path, then its arguments. */
  readonly command: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  /** The Deployment home. The daemon runs in it. */
  readonly workingDirectory: string;
  /** The folder for the launchd stdout and stderr files. systemd sends output to the journal. */
  readonly logDir: string;
  /** The configured `daemon.drainTimeout` in milliseconds. The default is `DEFAULT_DRAIN_TIMEOUT_MS`. */
  readonly drainTimeoutMs?: number;
}

/**
 * Returns the stop grace period for a drain timeout: 45 seconds, or longer if the drain timeout leaves less than 15
 * seconds for shutdown. The service manager thus never kills a daemon that still drains.
 */
export const stopGraceMs = (
  drainTimeoutMs: number = DEFAULT_DRAIN_TIMEOUT_MS
): number => Math.max(STOP_GRACE_MS, drainTimeoutMs + SHUTDOWN_MARGIN_MS);

const toSeconds = (ms: number): number => Math.ceil(ms / MS_PER_SECOND);

const LINE_BREAK = /[\r\n]/u;
const SYSTEMD_BARE_WORD = /^[A-Za-z0-9_/.:@+=,-]+$/u;
const BACKSLASH = /\\/gu;
const DOUBLE_QUOTE = /"/gu;
const PERCENT = /%/gu;
const DOLLAR = /\$/gu;

const assertSingleLine = (value: string): void => {
  if (LINE_BREAK.test(value)) {
    throw new Error(`Service values must not contain line breaks: ${value}`);
  }
};

const quoteSystemd = (value: string): string =>
  `"${value.replaceAll(BACKSLASH, "\\\\").replaceAll(DOUBLE_QUOTE, String.raw`\"`)}"`;

/** Escapes one `ExecStart=` word: `%` specifiers, `$` variables, and quotes. */
const systemdArg = (value: string): string => {
  assertSingleLine(value);
  const escaped = value.replaceAll(PERCENT, "%%").replaceAll(DOLLAR, "$$$$");

  return SYSTEMD_BARE_WORD.test(escaped) ? escaped : quoteSystemd(escaped);
};

const systemdValue = (value: string): string => {
  assertSingleLine(value);

  return quoteSystemd(value.replaceAll(PERCENT, "%%"));
};

/**
 * Renders the `systemd --user` unit. `KillMode=mixed` sends `SIGTERM` to the daemon only, so that it drains Runs and
 * stops its own MCP Server processes. After the stop grace period, systemd kills every remaining process of the unit.
 */
export const renderSystemdUnit = (spec: ServiceSpec): string => {
  const environment = Object.entries(spec.environment)
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `Environment=${systemdValue(`${key}=${value}`)}`);

  return [
    "[Unit]",
    "Description=Wheatley daemon",
    "",
    "[Service]",
    "Type=exec",
    `ExecStart=${spec.command.map(systemdArg).join(" ")}`,
    `WorkingDirectory=${systemdValue(spec.workingDirectory)}`,
    ...environment,
    "Restart=on-failure",
    "RestartSec=5",
    "KillMode=mixed",
    "KillSignal=SIGTERM",
    `TimeoutStopSec=${toSeconds(stopGraceMs(spec.drainTimeoutMs))}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
};

const XML_ESCAPES = new Map([
  ['"', "&quot;"],
  ["&", "&amp;"],
  ["'", "&apos;"],
  ["<", "&lt;"],
  [">", "&gt;"],
]);

const XML_SPECIAL = /["&'<>]/gu;

const xml = (value: string): string =>
  value.replaceAll(XML_SPECIAL, (char) => XML_ESCAPES.get(char) ?? char);

const plistString = (value: string): string => `<string>${xml(value)}</string>`;

/**
 * Renders the launchd agent plist. launchd restarts the daemon after a crash but not after a clean exit, and
 * `ExitTimeOut` is the stop grace period before `SIGKILL`.
 */
export const renderLaunchdPlist = (spec: ServiceSpec): string => {
  const args = spec.command.map((arg) => `    ${plistString(arg)}`);

  const environment = Object.entries(spec.environment)
    .toSorted(([a], [b]) => a.localeCompare(b))
    .flatMap(([key, value]) => [
      `    <key>${xml(key)}</key>`,
      `    ${plistString(value)}`,
    ]);

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  ${plistString(LAUNCHD_LABEL)}`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...args,
    "  </array>",
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    ...environment,
    "  </dict>",
    "  <key>WorkingDirectory</key>",
    `  ${plistString(spec.workingDirectory)}`,
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <dict>",
    "    <key>SuccessfulExit</key>",
    "    <false/>",
    "  </dict>",
    "  <key>ProcessType</key>",
    "  <string>Background</string>",
    "  <key>ExitTimeOut</key>",
    `  <integer>${toSeconds(stopGraceMs(spec.drainTimeoutMs))}</integer>`,
    "  <key>StandardOutPath</key>",
    `  ${plistString(path.join(spec.logDir, "daemon.out.log"))}`,
    "  <key>StandardErrorPath</key>",
    `  ${plistString(path.join(spec.logDir, "daemon.err.log"))}`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
};

const isExecutable = async (file: string): Promise<boolean> => {
  try {
    await access(file, constants.X_OK);

    const info = await stat(file);

    return info.isFile();
  } catch {
    return false;
  }
};

const findOnPath = async (
  name: string,
  searchPath: readonly string[]
): Promise<string | undefined> => {
  const candidates = searchPath.map((dir) => path.join(dir, name));
  const executable = await Promise.all(candidates.map(isExecutable));

  return candidates.find((_candidate, index) => executable[index] === true);
};

/** The `bin` script of this package, for a checkout that has no `wheatley` executable on `PATH`. */
export const packageBinScript = (): string =>
  fileURLToPath(new URL("../../bin/wheatley.js", import.meta.url));

export interface ServiceSpecInput {
  readonly env: NodeJS.ProcessEnv;
  /** The Node.js binary that runs this CLI, usually `process.execPath`. */
  readonly execPath: string;
  readonly homeDir: string;
  /** The `bin` script to run if `PATH` has no `wheatley` executable. */
  readonly binScript: string;
  readonly drainTimeoutMs?: number;
}

/**
 * Builds the service spec for this host.
 *
 * The unit starts the `wheatley` executable from `PATH`, because npm and pnpm keep that path stable across updates.
 * Without one, it runs `binScript` with Node.js. `PATH` in the unit starts with the real folder of the Node.js binary,
 * so that the `#!/usr/bin/env node` line and MCP Server commands such as `npx` resolve to the same Node.js version.
 */
export const resolveServiceSpec = async (
  input: ServiceSpecInput
): Promise<ServiceSpec> => {
  const nodeDir = path.dirname(await realpath(input.execPath));

  const searchPath = [
    ...new Set([
      nodeDir,
      ...(input.env.PATH ?? "").split(path.delimiter).filter(Boolean),
    ]),
  ];

  const executable = await findOnPath("wheatley", searchPath);

  const command =
    executable === undefined
      ? [path.join(nodeDir, path.basename(input.execPath)), input.binScript]
      : [executable];

  const hasHomeOverride =
    input.env[HOME_ENV] !== undefined && input.env[HOME_ENV] !== "";

  const pathValue = searchPath.join(path.delimiter);

  const environment = new Map([["PATH", pathValue]]);

  if (hasHomeOverride) {
    environment.set(HOME_ENV, input.homeDir);
  }

  return {
    command: [...command, DAEMON_SUBCOMMAND],
    environment: Object.fromEntries(environment),
    logDir: path.join(input.homeDir, "logs"),
    workingDirectory: input.homeDir,
    drainTimeoutMs: input.drainTimeoutMs,
  };
};

/** The state of the installed service. */
export type ServiceState =
  | "running"
  | "starting"
  | "stopping"
  | "stopped"
  | "failed"
  | "not_installed";

export interface ServiceStatus {
  readonly manager: ServiceManagerKind;
  readonly unitPath: string;
  readonly state: ServiceState;
  /** The daemon process ID, or `null` if it does not run. */
  readonly pid: number | null;
}

export interface InstallResult {
  readonly unitPath: string;
  /** Follow-up steps for the Operator. */
  readonly notes: readonly string[];
}

export type ServiceManagerKind = "systemd" | "launchd";

/** Controls the Wheatley daemon through the host service manager. */
export interface ServiceManager {
  readonly kind: ServiceManagerKind;
  /** The path of the unit file or plist. */
  readonly unitPath: string;
  /**
   * Writes the unit file and registers it to start at login (systemd `enable`, launchd `~/Library/LaunchAgents`). It
   * does not start the daemon. If the daemon runs, the new unit takes effect at the next `restart`.
   *
   * Errors: rejects if the file cannot be written or a service manager command fails.
   */
  readonly install: (spec: ServiceSpec) => Promise<InstallResult>;
  /**
   * Starts the daemon. Does nothing if it runs. Errors: rejects if the unit is not installed or the command fails.
   */
  readonly start: () => Promise<void>;
  /**
   * Stops the daemon with `SIGTERM`, then `SIGKILL` after the stop grace period. Does nothing if it does not run.
   * Errors: rejects if the unit is not installed or the command fails.
   */
  readonly stop: () => Promise<void>;
  /** Stops and starts the daemon. Errors: as `stop` and `start`. */
  readonly restart: () => Promise<void>;
  /** Reports the service state. Errors: rejects only if the service manager cannot run. */
  readonly status: () => Promise<ServiceStatus>;
}

export interface ServiceManagerOptions {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  readonly userHome: string;
  /** The user ID for the launchd `gui/<uid>` domain. */
  readonly uid: number;
  readonly runner: CommandRunner;
}

const fileExists = async (file: string): Promise<boolean> => {
  try {
    await stat(file);

    return true;
  } catch {
    return false;
  }
};

const run = async (
  runner: CommandRunner,
  command: string,
  args: readonly string[]
): Promise<CommandResult> => {
  const result = await runner.run(command, args);

  if (result.exitCode !== 0) {
    throw new Error(describeFailure(command, args, result));
  }

  return result;
};

const notInstalled = (unitPath: string): Error =>
  new Error(
    `The Wheatley service is not installed (${unitPath}). Run: wheatley service install`
  );

const SYSTEMD_STATES = new Map<string, ServiceState>([
  ["activating", "starting"],
  ["active", "running"],
  ["deactivating", "stopping"],
  ["failed", "failed"],
  ["inactive", "stopped"],
  ["reloading", "running"],
]);

const parseProperties = (text: string): Map<string, string> => {
  const properties = new Map<string, string>();

  for (const line of text.split("\n")) {
    const separator = line.indexOf("=");

    if (separator > 0) {
      properties.set(
        line.slice(0, separator).trim(),
        line.slice(separator + 1).trim()
      );
    }
  }

  return properties;
};

const parsePid = (value: string | undefined): number | null => {
  const pid = Number(value);

  return Number.isInteger(pid) && pid > 0 ? pid : null;
};

const createSystemdManager = (
  options: ServiceManagerOptions
): ServiceManager => {
  const configHome =
    options.env.XDG_CONFIG_HOME === undefined ||
    options.env.XDG_CONFIG_HOME === ""
      ? path.join(options.userHome, ".config")
      : options.env.XDG_CONFIG_HOME;

  const unitPath = path.join(configHome, "systemd", "user", SYSTEMD_UNIT_NAME);

  const systemctl = async (...args: string[]): Promise<CommandResult> =>
    await run(options.runner, "systemctl", ["--user", ...args]);

  const requireInstalled = async (): Promise<void> => {
    if (!(await fileExists(unitPath))) {
      throw notInstalled(unitPath);
    }
  };

  return {
    install: async (spec) => {
      await mkdir(path.dirname(unitPath), { recursive: true });
      await writeFile(unitPath, renderSystemdUnit(spec), { mode: 0o644 });
      await systemctl("daemon-reload");
      await systemctl("enable", SYSTEMD_UNIT_NAME);

      return {
        notes: [
          "Run `wheatley service start` to start the daemon now.",
          "Run `loginctl enable-linger` to keep the daemon running after you log out.",
        ],
        unitPath,
      };
    },
    kind: "systemd",
    restart: async () => {
      await requireInstalled();
      await systemctl("restart", SYSTEMD_UNIT_NAME);
    },
    start: async () => {
      await requireInstalled();
      await systemctl("start", SYSTEMD_UNIT_NAME);
    },
    status: async () => {
      if (!(await fileExists(unitPath))) {
        return {
          manager: "systemd",
          pid: null,
          state: "not_installed",
          unitPath,
        };
      }

      const result = await systemctl(
        "show",
        SYSTEMD_UNIT_NAME,
        "--property=ActiveState,MainPID"
      );

      const properties = parseProperties(result.stdout);

      return {
        manager: "systemd",
        pid: parsePid(properties.get("MainPID")),
        state:
          SYSTEMD_STATES.get(properties.get("ActiveState") ?? "") ?? "stopped",
        unitPath,
      };
    },
    stop: async () => {
      await requireInstalled();
      await systemctl("stop", SYSTEMD_UNIT_NAME);
    },
    unitPath,
  };
};

const LAUNCHD_STATE = /^\s*state = (?<state>.+)$/mu;
const LAUNCHD_PID = /^\s*pid = (?<pid>\d+)$/mu;
const LAUNCHD_EXIT = /^\s*last exit code = (?<code>-?\d+)/mu;

const launchdState = (output: string): ServiceState => {
  if (LAUNCHD_STATE.exec(output)?.groups?.state === "running") {
    return "running";
  }

  const exitCode = LAUNCHD_EXIT.exec(output)?.groups?.code;

  return exitCode === undefined || exitCode === "0" ? "stopped" : "failed";
};

const createLaunchdManager = (
  options: ServiceManagerOptions
): ServiceManager => {
  const unitPath = path.join(
    options.userHome,
    "Library",
    "LaunchAgents",
    `${LAUNCHD_LABEL}.plist`
  );

  const domain = `gui/${options.uid}`;
  const target = `${domain}/${LAUNCHD_LABEL}`;

  const print = async (): Promise<CommandResult> =>
    await options.runner.run("launchctl", ["print", target]);

  const isLoaded = async (): Promise<boolean> => {
    const result = await print();

    return result.exitCode === 0;
  };

  const requireInstalled = async (): Promise<void> => {
    if (!(await fileExists(unitPath))) {
      throw notInstalled(unitPath);
    }
  };

  const start = async (): Promise<void> => {
    await requireInstalled();
    await ((await isLoaded())
      ? run(options.runner, "launchctl", ["kickstart", target])
      : run(options.runner, "launchctl", ["bootstrap", domain, unitPath]));
  };

  const stop = async (): Promise<void> => {
    await requireInstalled();

    if (await isLoaded()) {
      await run(options.runner, "launchctl", ["bootout", target]);
    }
  };

  return {
    install: async (spec) => {
      await mkdir(path.dirname(unitPath), { recursive: true });
      await mkdir(spec.logDir, { recursive: true });
      await writeFile(unitPath, renderLaunchdPlist(spec), { mode: 0o644 });
      await run(options.runner, "plutil", ["-lint", unitPath]);

      return {
        notes: [
          "Run `wheatley service start` to start the daemon now. launchd starts it at each login.",
        ],
        unitPath,
      };
    },
    kind: "launchd",
    restart: async () => {
      await stop();
      await start();
    },
    start,
    status: async () => {
      if (!(await fileExists(unitPath))) {
        return {
          manager: "launchd",
          pid: null,
          state: "not_installed",
          unitPath,
        };
      }

      const result = await print();

      if (result.exitCode !== 0) {
        return { manager: "launchd", pid: null, state: "stopped", unitPath };
      }

      return {
        manager: "launchd",
        pid: parsePid(LAUNCHD_PID.exec(result.stdout)?.groups?.pid),
        state: launchdState(result.stdout),
        unitPath,
      };
    },
    stop,
    unitPath,
  };
};

/**
 * Returns the service manager of this host: `systemd --user` on Linux and launchd on macOS.
 *
 * Errors: throws on another platform, and inside the Docker image, where Docker Compose runs the daemon.
 */
export const createServiceManager = (
  options: ServiceManagerOptions
): ServiceManager => {
  if (options.env[DOCKER_ENV] === "1") {
    throw new Error(
      "wheatley service does not apply in Docker. Docker Compose runs the daemon."
    );
  }

  if (options.platform === "linux") {
    return createSystemdManager(options);
  }

  if (options.platform === "darwin") {
    return createLaunchdManager(options);
  }

  throw new Error(
    `wheatley service supports Linux (systemd) and macOS (launchd), not ${options.platform}`
  );
};
