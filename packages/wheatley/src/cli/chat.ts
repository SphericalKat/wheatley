import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { styleText } from "node:util";

import type { PendingApproval, RpcEvent } from "@wheatley-ai/protocol";
import { BUILTIN_COMMANDS, parseCommandText } from "@wheatley-ai/sdk";
import type { CommandSpec } from "@wheatley-ai/sdk";

import { CLI_CHAT_ID } from "../core/agent/agent.js";
import { CLI_BINDING_ID } from "../core/config/validate.js";
import { errorMessage } from "../core/error-message.js";
import type { DaemonClient } from "./client.js";
import type { CliIo } from "./io.js";
import {
  approvalQuestion,
  chooseAgent,
  connect,
  decideApproval,
} from "./session.js";
import type { ClientFlags } from "./session.js";
import { openTerminal } from "./terminal.js";
import type { TerminalUi } from "./terminal.js";

/** Lines that end the chat. */
const EXIT_LINES = new Set(["/exit", "/quit"]);

const HELP_LINE = "/help";

/** The file in the Deployment home that keeps the input history of the interactive chat. */
const HISTORY_FILE = "chat_history";

const LOGO = "◉";
const PROMPT = `${styleText("cyan", "›")} `;
const APPROVAL_PROMPT = `${styleText("yellow", "allow?")} ${styleText("dim", "[o]nce [c]onversation [a]lways [d]eny <reason>")} ${styleText("yellow", "›")} `;

const isCliChatRun = (event: RpcEvent): boolean =>
  (event.name === "run.started" || event.name === "run.finished") &&
  event.payload.run.origin.kind === "chat" &&
  event.payload.run.origin.bindingId === CLI_BINDING_ID &&
  event.payload.run.origin.chatId === CLI_CHAT_ID;

/**
 * Tracks the Runs of the CLI Chat and its open Approvals while the chat runs. A sent message counts as busy until the
 * Agent's echo of it names its Run. The echo and the Run events can arrive before or after the `chat.send` response
 * is handled, so every step works in any order.
 */
class ChatState {
  readonly approvals: PendingApproval[] = [];
  readonly #waiting = new Set<string>();
  readonly #echoed = new Set<string>();
  readonly #active = new Set<string>();
  readonly #finished = new Set<string>();
  #idle = Promise.withResolvers<undefined>();

  constructor() {
    this.#idle.resolve(undefined);
  }

  readonly removeApproval = (approvalId: string): void => {
    const index = this.approvals.findIndex(
      (approval) => approval.approvalId === approvalId
    );

    if (index !== -1) {
      this.approvals.splice(index, 1);
    }
  };

  /** This chat sent a message. */
  readonly sent = (messageId: string): void => {
    if (this.#echoed.delete(messageId)) {
      return;
    }

    this.#busy();
    this.#waiting.add(messageId);
  };

  /** The Agent stored a user message of this Chat for a Run. */
  readonly echoed = (messageId: string, runId: string | undefined): void => {
    if (!this.#waiting.delete(messageId)) {
      this.#echoed.add(messageId);
    }

    if (runId !== undefined) {
      this.started(runId);
    }

    this.#settle();
  };

  readonly started = (runId: string): void => {
    if (this.#finished.has(runId)) {
      return;
    }

    this.#busy();
    this.#active.add(runId);
  };

  readonly finished = (runId: string): void => {
    this.#finished.add(runId);
    this.#active.delete(runId);
    this.#settle();
  };

  /** True while a message waits for its Run or a Run of the CLI Chat is active. */
  get busy(): boolean {
    return this.#active.size > 0 || this.#waiting.size > 0;
  }

  /** Resolves when no message waits for its Run and no Run of the CLI Chat is active. */
  get idle(): Promise<undefined> {
    return this.#idle.promise;
  }

  readonly #busy = (): void => {
    if (this.#active.size === 0 && this.#waiting.size === 0) {
      this.#idle = Promise.withResolvers<undefined>();
    }
  };

  readonly #settle = (): void => {
    if (this.#active.size === 0 && this.#waiting.size === 0) {
      this.#idle.resolve(undefined);
    }
  };
}

/** Updates the chat state for one event. */
const track = (state: ChatState, event: RpcEvent): void => {
  if (event.name === "chat.message" && event.payload.message.role === "user") {
    state.echoed(event.payload.message.messageId, event.payload.message.runId);
  } else if (event.name === "approval.requested") {
    state.approvals.push(event.payload.approval);
  } else if (event.name === "approval.resolved") {
    state.removeApproval(event.payload.approvalId);
  } else if (isCliChatRun(event) && event.name === "run.started") {
    state.started(event.payload.run.runId);
  } else if (isCliChatRun(event) && event.name === "run.finished") {
    state.finished(event.payload.run.runId);
  }
};

const failedRunError = (event: RpcEvent): string | undefined =>
  isCliChatRun(event) &&
  event.name === "run.finished" &&
  event.payload.run.status === "failed"
    ? (event.payload.run.error ?? "unknown error")
    : undefined;

/** Writes one event as plain lines, for pipes and scripts. */
const renderPlain = (io: CliIo, agent: string, event: RpcEvent): void => {
  const runError = failedRunError(event);

  if (event.name === "chat.message" && event.payload.message.role !== "user") {
    io.stdout(`${agent}> ${event.payload.message.text}\n`);
  } else if (event.name === "run.toolStarted") {
    io.stdout(`  [${event.payload.toolName}] ${event.payload.inputPreview}\n`);
  } else if (event.name === "run.toolFinished" && event.payload.isError) {
    io.stdout(
      `  [${event.payload.toolName} failed] ${event.payload.outputPreview}\n`
    );
  } else if (event.name === "approval.requested") {
    io.stdout(approvalQuestion(event.payload.approval));
  } else if (runError !== undefined) {
    io.stderr(`The Run failed: ${runError}\n`);
  }
};

/** Indents every line after the first, so that a reply lines up after its logo. */
const indent = (text: string): string => text.replaceAll("\n", "\n  ");

/** Writes one event to the interactive terminal. Returns the new spinner label, if the event changes it. */
const renderTerminal = (
  ui: TerminalUi,
  event: RpcEvent
): string | undefined => {
  const runError = failedRunError(event);

  if (event.name === "chat.message" && event.payload.message.role !== "user") {
    ui.print(
      `${styleText("cyan", LOGO)} ${indent(event.payload.message.text)}\n`
    );
  } else if (event.name === "run.toolStarted") {
    ui.print(
      styleText(
        "dim",
        `  ↳ ${event.payload.toolName} ${event.payload.inputPreview}`
      )
    );

    return `running ${event.payload.toolName}`;
  } else if (event.name === "run.toolFinished") {
    if (event.payload.isError) {
      ui.print(
        styleText(
          "red",
          `  ✗ ${event.payload.toolName} failed: ${event.payload.outputPreview}`
        )
      );
    }

    return "thinking";
  } else if (event.name === "approval.requested") {
    const { approval } = event.payload;

    ui.print(
      `${styleText("yellow", "?")} ${styleText("bold", approval.toolName)} needs approval\n${styleText("dim", `  ${indent(approval.inputPreview)}`)}`
    );
  } else if (runError !== undefined) {
    ui.print(styleText("red", `✗ The Run failed: ${runError}`));
  }

  return undefined;
};

const handleLine = async (
  io: CliIo,
  client: DaemonClient,
  agent: string,
  state: ChatState,
  line: string
): Promise<void> => {
  const [approval] = state.approvals;

  if (approval !== undefined) {
    // Events that arrive during the request can already remove this Approval and queue the next one.
    if (await decideApproval(io, client, agent, approval, line)) {
      state.removeApproval(approval.approvalId);
    }

    return;
  }

  const command = parseCommandText(line);

  if (command === undefined) {
    const { messageId } = await client.request("chat.send", {
      agent,
      text: line,
    });

    state.sent(messageId);

    return;
  }

  // `Agent.command` sends the reply for a command that cannot run, so the CLI ignores `accepted`.
  await client.request("chat.command", {
    agent,
    args: command.args,
    name: command.name,
  });
};

const COMMAND_WORDS = [
  ...BUILTIN_COMMANDS.map((command) => `/${command.name}`),
  HELP_LINE,
  "/exit",
];

const helpText = (): string =>
  [
    ...BUILTIN_COMMANDS.map(
      (command: CommandSpec) =>
        `  ${styleText("cyan", `/${command.name}`)}${command.argument === undefined ? "" : ` ${command.argument}`}  ${styleText("dim", command.description)}`
    ),
    `  ${styleText("cyan", "/exit")}  ${styleText("dim", "End the chat")}`,
    styleText(
      "dim",
      "  Tab completes a command. Ctrl+C stops the active Run. Ctrl+D ends the chat."
    ),
  ].join("\n");

const readHistory = async (file: string): Promise<string[]> => {
  try {
    const text = await readFile(file, "utf-8");

    return text.split("\n").filter(Boolean);
  } catch {
    return [];
  }
};

const writeHistory = async (
  file: string,
  history: readonly string[]
): Promise<void> => {
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${history.join("\n")}\n`, { mode: 0o600 });
  } catch {
    // The history is a convenience. A chat without it still works.
  }
};

/** Opens the interactive terminal, or returns `undefined` for a pipe or a script. */
const openChatTerminal = async (
  io: CliIo,
  home: string
): Promise<TerminalUi | undefined> => {
  const streams = io.terminal?.();

  if (streams === undefined) {
    return undefined;
  }

  const file = path.join(home, HISTORY_FILE);
  const history = await readHistory(file);

  return openTerminal(streams.input, streams.output, {
    completions: COMMAND_WORDS,
    history,
    onHistory: (next) => {
      void writeHistory(file, next);
    },
  });
};

/** Keeps the prompt and the spinner in step with the chat state. */
const syncStatus = (ui: TerminalUi, state: ChatState, label: string): void => {
  if (state.approvals.length > 0) {
    ui.stopSpin();
    ui.setPrompt(APPROVAL_PROMPT);

    return;
  }

  ui.setPrompt(PROMPT);

  if (state.busy) {
    ui.spin(label);
  } else {
    ui.stopSpin();
  }
};

/** The output of a chat: plain text, or the interactive terminal with its status. */
const chatOutput = (io: CliIo, ui: TerminalUi | undefined): CliIo =>
  ui === undefined
    ? io
    : {
        ...io,
        stderr: (text) => {
          ui.print(styleText("red", text));
        },
        stdout: (text) => {
          if (text !== "") {
            ui.print(text);
          }
        },
      };

/**
 * `wheatley chat`: an interactive session in the Agent's CLI Chat (`cli` binding, Chat `default`), which the dashboard
 * shares (ADR 0007). Lines that start with a built-in command run it; `/exit` or the end of input ends the session
 * after the active Runs end. While an Approval waits, the next line answers it.
 *
 * On a terminal, the chat shows a prompt with Tab completion and saved history, and a spinner while a Run works.
 * Ctrl+C then stops the active Run. Pipes and scripts get plain lines.
 *
 * Resolves with the exit code.
 */
export const runChat = async (
  io: CliIo,
  flags: ClientFlags,
  version: string
): Promise<number> => {
  const client = await connect(io, flags, version);

  if (client === undefined) {
    return 1;
  }

  let ui: TerminalUi | undefined;

  try {
    const agent = await chooseAgent(client, flags.agent);
    const state = new ChatState();

    ui = await openChatTerminal(io, flags.home);

    const out = chatOutput(io, ui);
    const terminal = ui;
    let label = "thinking";

    const sync = (): void => {
      if (terminal !== undefined) {
        syncStatus(terminal, state, label);
      }
    };

    client.onEvent((event) => {
      track(state, event);

      if (terminal === undefined) {
        renderPlain(io, agent, event);

        return;
      }

      if (event.name === "run.started") {
        label = "thinking";
      }

      label = renderTerminal(terminal, event) ?? label;
      sync();
    });

    if (terminal !== undefined) {
      terminal.onInterrupt = () => {
        if (!state.busy || state.approvals.length > 0) {
          return false;
        }

        terminal.print(styleText("dim", "Stopping the Run…"));
        client.request("chat.command", { agent, name: "stop" }).catch(() => {
          // The Run can end before the request arrives.
        });

        return true;
      };
    }

    await client.request("events.subscribe", {
      agents: [agent],
      topics: ["chat", "run", "approval"],
    });

    if (terminal === undefined) {
      io.stdout(
        `Chat with ${agent}. Commands: ${BUILTIN_COMMANDS.map((command) => `/${command.name}`).join(" ")} /exit\n`
      );
    } else {
      terminal.print(
        `${styleText(["cyan", "bold"], `${LOGO} wheatley`)} ${styleText("dim", version)}\n${styleText("dim", `  Chat with ${agent}. Type /help for commands.`)}\n`
      );
      sync();
    }

    const lines = terminal?.lines ?? io.lines;

    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- The chat reads one line at a time.
      const result = await lines.next();
      const line = result.done === true ? undefined : result.value.trim();

      if (line === undefined || EXIT_LINES.has(line)) {
        break;
      }

      if (terminal !== undefined && line === HELP_LINE) {
        terminal.print(helpText());
      } else if (line !== "") {
        label = "thinking";

        try {
          // oxlint-disable-next-line no-await-in-loop -- Each line is handled before the next one is read.
          await handleLine(out, client, agent, state, line);
        } catch (error) {
          // A pipe or a script stops at the first error. An interactive chat reports it and goes on.
          if (terminal === undefined) {
            throw error;
          }

          terminal.print(styleText("red", `✗ ${errorMessage(error)}`));
        }

        sync();
      }
    }

    await state.idle;

    return 0;
  } catch (error) {
    io.stderr(`${errorMessage(error)}\n`);

    return 1;
  } finally {
    ui?.close();
    await client.close();
  }
};
