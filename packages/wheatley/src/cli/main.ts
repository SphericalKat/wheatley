import { createConnection } from "node:net";

import { Command, CommanderError, InvalidArgumentError } from "commander";

import { daemonSocket } from "../core/daemon-socket.js";
import { addOpsCommands, hostCliDeps } from "../ops/cli.js";
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

const EXIT_OK = 0;
const EXIT_USAGE = 2;

/** Commander error codes after `--help`, `--version`, or a missing command, which print help or the version. */
const OUTPUT_CODES = new Set([
  "commander.help",
  "commander.helpDisplayed",
  "commander.version",
]);

interface HomeOption {
  readonly home?: string;
}

interface ClientOptions {
  readonly agent?: string;
  readonly url?: string;
}

interface InitCommandOptions {
  readonly agent?: string;
  readonly model?: string;
  readonly provider?: string;
}

interface DaemonOptions {
  readonly host?: string;
  readonly port?: number;
}

const parsePort = (value: string): number => {
  const port = Number(value);

  if (!Number.isInteger(port)) {
    throw new InvalidArgumentError(`Invalid port: ${value}`);
  }

  return port;
};

const addClientOptions = (command: Command): Command =>
  command
    .option("--agent <name>", "The Agent")
    .option(
      "--url <ws-url>",
      "Connect over TCP instead of the Unix socket in the home folder"
    );

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

const CHAT_VALUE_OPTIONS = new Set(["--home", "--agent", "--url"]);
const CHAT_OPTION_PREFIXES = ["--home=", "--agent=", "--url="];

/**
 * Routes bare `wheatley` (and `wheatley` with only chat or global options) to `chat`.
 * Leaves `--help`, `--version`, explicit subcommands, and unknown options untouched.
 */
const defaultToChat = (argv: readonly string[]): readonly string[] => {
  let expectValue = false;

  for (const arg of argv) {
    if (expectValue) {
      expectValue = false;
      continue;
    }

    if (CHAT_VALUE_OPTIONS.has(arg)) {
      expectValue = true;
      continue;
    }

    if (CHAT_OPTION_PREFIXES.some((prefix) => arg.startsWith(prefix))) {
      continue;
    }

    return argv;
  }

  return ["chat", ...argv];
};

/**
 * Creates the command tree of one `runCli` call. Its actions pass their exit code to `exit`. Commander writes help,
 * version, and usage errors to `io` and throws a `CommanderError` in place of `process.exit()`.
 */
const createProgram = (
  io: CliIo,
  version: string,
  overrides: CliOverrides,
  exit: (code: number) => void
): Command => {
  const program = new Command("wheatley")
    .usage("[command] [options]")
    .helpOption("-h, --help", "Show this help")
    // The CLI has no `help` command. Commander adds one by default.
    .helpCommand(false)
    .version(version, "--version", "Show the Wheatley version")
    .option(
      "--home <dir>",
      "The Deployment home (default: $WHEATLEY_HOME or ~/.wheatley)"
    )
    .configureHelp({ showGlobalOptions: true })
    .configureOutput({ writeErr: io.stderr, writeOut: io.stdout })
    .showHelpAfterError()
    .exitOverride();

  const homeOf = (command: Command): string =>
    resolveHome(command.optsWithGlobals<HomeOption>().home, io.env);

  const clientOf = (command: Command, options: ClientOptions): ClientFlags => ({
    agent: options.agent,
    home: homeOf(command),
    url: options.url,
  });

  program
    .command("init")
    .description("Create config.yaml and secrets.yaml in the Deployment home")
    .option("--agent <name>", "The name of the first Agent")
    .option("--provider <name>", "The model provider of the first Agent")
    .option("--model <id>", "The model of the first Agent")
    .action(async (options: InitCommandOptions, command: Command) => {
      exit(
        await runInit(io, {
          agent: options.agent,
          home: homeOf(command),
          model: options.model,
          provider: options.provider,
        })
      );
    });

  program
    .command("daemon")
    .description("Run the Deployment and its Control Server in the foreground")
    .option("--host <host>", "The TCP host")
    .option("--port <port>", "The TCP port", parsePort)
    .action(async (options: DaemonOptions, command: Command) => {
      exit(
        await runDaemon(io, {
          home: homeOf(command),
          host: options.host,
          overrides: overrides.daemon,
          port: options.port,
          version,
        })
      );
    });

  addClientOptions(
    program
      .command("chat")
      .description("Chat with an Agent in its CLI Chat (default)")
  ).action(async (options: ClientOptions, command: Command) => {
    exit(
      await runChat(io, clientOf(command, options), version, overrides.daemon)
    );
  });

  addClientOptions(
    program
      .command("ask")
      .description("Send one prompt to an Agent and print the reply")
      .argument(
        "[prompt...]",
        "The prompt. Without it, ask reads the prompt from standard input"
      )
  ).action(
    async (words: string[], options: ClientOptions, command: Command) => {
      const prompt = await readPrompt(io, words);

      if (prompt.trim() === "") {
        io.stderr("ask needs a prompt as arguments or on standard input.\n");
        exit(EXIT_USAGE);

        return;
      }

      exit(
        await runAsk(
          io,
          clientOf(command, options),
          prompt,
          version,
          overrides.daemon
        )
      );
    }
  );

  addClientOptions(
    program.command("status").description("Show the health of the Deployment")
  ).action(async (options: ClientOptions, command: Command) => {
    exit(await runStatus(io, clientOf(command, options), version));
  });

  addOpsCommands(program, {
    deps: (command) => {
      const home = homeOf(command);

      return {
        ...hostCliDeps(async () => await isDaemonRunning(home)),
        homeDir: home,
        ...overrides.ops,
      };
    },
    exit,
    io: {
      err: (line) => {
        io.stderr(`${line}\n`);
      },
      out: (line) => {
        io.stdout(`${line}\n`);
      },
    },
  });

  return program;
};

/**
 * Runs one CLI command and resolves with its exit code: 0 for success, `--help`, and `--version`, 1 for a runtime
 * failure, and 2 for a usage error. `argv` excludes the program name, for example
 * `["ask", "--agent", "home", "What", "now?"]`. `--home` can come before or after the command.
 */
export const runCli = async (
  argv: readonly string[],
  io: CliIo,
  overrides: CliOverrides = {}
): Promise<number> => {
  let exitCode = EXIT_OK;

  const program = createProgram(
    io,
    await packageVersion(),
    overrides,
    (code) => {
      exitCode = code;
    }
  );

  try {
    await program.parseAsync([...defaultToChat(argv)], { from: "user" });
  } catch (error) {
    if (!(error instanceof CommanderError)) {
      throw error;
    }

    return OUTPUT_CODES.has(error.code) ? EXIT_OK : EXIT_USAGE;
  }

  return exitCode;
};
