import { parseArgs } from "node:util";

import { errorMessage } from "../core/error-message.js";
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

Options:
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
}

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
  let parsed: ReturnType<typeof parseCliArgs>;

  try {
    parsed = parseCliArgs(argv);
  } catch (error) {
    io.stderr(`${errorMessage(error)}\n${USAGE}`);

    return 2;
  }

  const { values, positionals } = parsed;
  const [command, ...rest] = positionals;
  const home = resolveHome(values.home, io.env);
  const version = await packageVersion();
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
      home: { type: "string" },
      host: { type: "string" },
      model: { type: "string" },
      port: { type: "string" },
      provider: { type: "string" },
      url: { type: "string" },
    },
    strict: true,
  });
