import { createConnection } from "node:net";
import { parseArgs } from "node:util";

import { daemonSocket } from "../core/daemon-socket.js";
import { errorMessage } from "../core/error-message.js";
import { createOpsCommands, hostCliDeps } from "../ops/cli.js";
import type { OpsCliDeps } from "../ops/cli.js";
import { runAsk } from "./ask.js";
import { runChat } from "./chat.js";
import { runDaemon } from "./daemon.js";
import type { DaemonCommandOptions } from "./daemon.js";
import { runInit } from "./init.js";
import type { CliIo } from "./io.js";
import { nextLine, packageVersion, resolveHome } from "./io.js";
import type { ClientFlags } from "./session.js";
import { runStatus } from "./status.js";

/** The usage text of the CLI. */
export const USAGE = `Usage: wheatley <command> [options]

Commands:
  init      Create config.yaml and secrets.yaml in the Deployment home
  daemon    Run the Deployment and its Control Server in the foreground
  chat      Chat with an Agent in its CLI Chat
  ask       Send one prompt to an Agent and print the reply
  status    Show the health of the Deployment
  service   Install or control the Wheatley service: install, start, stop, restart, status
  update    Update Wheatley within its major version (--check, --method npm|pnpm|yarn|bun|brew|curl)
  restore   List the backups of an Agent, or restore agent.sqlite: restore <agent> [backup]

Options:
  -h, --help         Show this help
  --version          Show the Wheatley version
  --home <dir>       The Deployment home (default: $WHEATLEY_HOME or ~/.wheatley)
  --url <ws-url>     Connect over TCP instead of the Unix socket in the home folder
  --agent <name>     The Agent of chat and ask
  --provider <name>  init: the model provider of the first Agent
  --model <id>       init: the model of the first Agent
  --host <host>      daemon: the TCP host
  --port <port>      daemon: the TCP port
`;

/** Embedding overrides of `runCli`. */
export interface CliOverrides {
  readonly daemon?: DaemonCommandOptions["overrides"];
  /** Replaces host dependencies of `service`, `update`, and `restore`, for example a fake command runner. */
  readonly ops?: Partial<OpsCliDeps>;
}

/**
 * Resolves `true` if a daemon accepts connections on the Unix socket of `home` (see `daemonSocket`). Resolves `false`
 * if the connection fails for any reason, for example a missing socket file. It does not reject.
 */
export const isDaemonRunning = async (home: string): Promise<boolean> => {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const socket = createConnection(daemonSocket(home).path);

  socket.once("connect", () => {
    socket.destroy();
    resolve(true);
  });
  socket.once("error", () => {
    resolve(false);
  });

  return await promise;
};

const OPS_COMMANDS = ["service", "update", "restore"] as const;

type OpsCommandName = (typeof OPS_COMMANDS)[number];

const isOpsCommand = (command: string | undefined): command is OpsCommandName =>
  OPS_COMMANDS.some((name) => name === command);

/** Runs `service`, `update`, or `restore` with the ops line-based output. */
const runOpsCommand = async (
  command: OpsCommandName,
  argv: readonly string[],
  io: CliIo,
  home: string,
  overrides: Partial<OpsCliDeps> | undefined
): Promise<number> => {
  const commands = createOpsCommands({
    ...hostCliDeps(async () => await isDaemonRunning(home)),
    homeDir: home,
    ...overrides,
  });

  return await commands[command](argv, {
    err: (line) => {
      io.stderr(`${line}\n`);
    },
    out: (line) => {
      io.stdout(`${line}\n`);
    },
  });
};

/** The ops arguments without `--home`, and the `--home` value if one was given. */
interface OpsArguments {
  readonly home: string | undefined;
  readonly rest: readonly string[];
}

const HOME_FLAG = "--home";

/**
 * Takes `--home <dir>` and `--home=<dir>` out of ops arguments, which the ops commands do not parse themselves.
 *
 * Errors: throws if `--home` has no value.
 */
const takeHomeOption = (argv: readonly string[]): OpsArguments => {
  const rest: string[] = [];
  let home: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";

    if (arg.startsWith(`${HOME_FLAG}=`)) {
      home = arg.slice(HOME_FLAG.length + 1);
    } else if (arg === HOME_FLAG) {
      home = argv[index + 1];
      index += 1;

      if (home === undefined || home.startsWith("-")) {
        throw new Error(`Option '${HOME_FLAG} <dir>' argument missing`);
      }
    } else {
      rest.push(arg);
    }
  }

  return { home, rest };
};

const readPrompt = async (
  io: CliIo,
  positionals: readonly string[]
): Promise<string> => {
  if (positionals.length > 0) {
    return positionals.join(" ");
  }

  const lines: string[] = [];

  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- Standard input arrives one line at a time.
    const line = await nextLine(io);

    if (line === undefined) {
      return lines.join("\n");
    }

    lines.push(line);
  }
};

/**
 * Runs one CLI command and resolves with its exit code. `argv` excludes the program name, for example
 * `["ask", "--agent", "home", "What", "now?"]`.
 */
export const runCli = async (
  argv: readonly string[],
  io: CliIo,
  overrides: CliOverrides = {}
): Promise<number> => {
  let ops: OpsArguments;

  try {
    ops = takeHomeOption(argv);
  } catch (error) {
    io.stderr(`${errorMessage(error)}\n${USAGE}`);

    return 2;
  }

  const [first, ...opsArgs] = ops.rest;

  // The ops commands parse their own flags, so they skip the root parser.
  if (isOpsCommand(first)) {
    return await runOpsCommand(
      first,
      opsArgs,
      io,
      resolveHome(ops.home, io.env),
      overrides.ops
    );
  }

  let parsed: ReturnType<typeof parseCliArgs>;

  try {
    parsed = parseCliArgs(argv);
  } catch (error) {
    io.stderr(`${errorMessage(error)}\n${USAGE}`);

    return 2;
  }

  const { values, positionals } = parsed;

  if (values.help === true) {
    io.stdout(USAGE);

    return 0;
  }

  const version = await packageVersion();

  if (values.version === true) {
    io.stdout(`${version}\n`);

    return 0;
  }

  const [command, ...rest] = positionals;
  const home = resolveHome(values.home, io.env);
  const client: ClientFlags = { agent: values.agent, home, url: values.url };

  switch (command) {
    case "init": {
      return await runInit(io, {
        agent: values.agent,
        home,
        model: values.model,
        provider: values.provider,
      });
    }

    case "daemon": {
      const port = values.port === undefined ? undefined : Number(values.port);

      if (port !== undefined && !Number.isInteger(port)) {
        io.stderr(`Invalid port: ${values.port}\n`);

        return 2;
      }

      return await runDaemon(io, {
        home,
        host: values.host,
        overrides: overrides.daemon,
        port,
        version,
      });
    }

    case "chat": {
      return await runChat(io, client, version);
    }

    case "ask": {
      const prompt = await readPrompt(io, rest);

      if (prompt.trim() === "") {
        io.stderr("ask needs a prompt as arguments or on standard input.\n");

        return 2;
      }

      return await runAsk(io, client, prompt, version);
    }

    case "status": {
      return await runStatus(io, client, version);
    }

    case undefined: {
      io.stderr(USAGE);

      return 0;
    }

    default: {
      io.stderr(`Unknown command: ${command}\n${USAGE}`);

      return 2;
    }
  }
};

const parseCliArgs = (argv: readonly string[]) =>
  parseArgs({
    allowPositionals: true,
    args: [...argv],
    options: {
      agent: { type: "string" },
      help: { short: "h", type: "boolean" },
      home: { type: "string" },
      host: { type: "string" },
      model: { type: "string" },
      port: { type: "string" },
      provider: { type: "string" },
      url: { type: "string" },
      version: { type: "boolean" },
    },
    strict: true,
  });
