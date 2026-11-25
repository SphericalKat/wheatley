import type { PendingApproval, RpcEvent } from "@wheatley-ai/protocol";
import { BUILTIN_COMMANDS, parseCommandText } from "@wheatley-ai/sdk";

import { CLI_CHAT_ID } from "../core/agent/agent.js";
import { CLI_BINDING_ID } from "../core/config/validate.js";
import { errorMessage } from "../core/error-message.js";
import type { DaemonClient } from "./client.js";
import type { CliIo } from "./io.js";
import { nextLine } from "./io.js";
import {
  approvalQuestion,
  chooseAgent,
  connect,
  decideApproval,
} from "./session.js";
import type { ClientFlags } from "./session.js";

/** Lines that end the chat. */
const EXIT_LINES = new Set(["/exit", "/quit"]);

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

const render = (
  io: CliIo,
  agent: string,
  state: ChatState,
  event: RpcEvent
): void => {
  if (event.name === "chat.message" && event.payload.message.role === "user") {
    state.echoed(event.payload.message.messageId, event.payload.message.runId);
  } else if (event.name === "chat.message") {
    io.stdout(`${agent}> ${event.payload.message.text}\n`);
  } else if (event.name === "run.toolStarted") {
    io.stdout(`  [${event.payload.toolName}] ${event.payload.inputPreview}\n`);
  } else if (event.name === "run.toolFinished" && event.payload.isError) {
    io.stdout(
      `  [${event.payload.toolName} failed] ${event.payload.outputPreview}\n`
    );
  } else if (event.name === "approval.requested") {
    state.approvals.push(event.payload.approval);
    io.stdout(approvalQuestion(event.payload.approval));
  } else if (event.name === "approval.resolved") {
    state.removeApproval(event.payload.approvalId);
  } else if (isCliChatRun(event) && event.name === "run.started") {
    state.started(event.payload.run.runId);
  } else if (isCliChatRun(event) && event.name === "run.finished") {
    if (event.payload.run.status === "failed") {
      io.stderr(
        `The Run failed: ${event.payload.run.error ?? "unknown error"}\n`
      );
    }

    state.finished(event.payload.run.runId);
  }
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

  const { accepted } = await client.request("chat.command", {
    agent,
    args: command.args,
    name: command.name,
  });

  if (!accepted) {
    io.stdout(`/${command.name} did not run.\n`);
  }
};

/**
 * `wheatley chat`: an interactive session in the Agent's CLI Chat (`cli` binding, Chat `default`), which the dashboard
 * shares (ADR 0007). Lines that start with a built-in command run it; `/exit` or the end of input ends the session
 * after the active Runs end. While an Approval waits, the next line answers it.
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

  try {
    const agent = await chooseAgent(client, flags.agent);
    const state = new ChatState();

    client.onEvent((event) => {
      render(io, agent, state, event);
    });
    await client.request("events.subscribe", {
      agents: [agent],
      topics: ["chat", "run", "approval"],
    });
    io.stdout(
      `Chat with ${agent}. Commands: ${BUILTIN_COMMANDS.map((command) => `/${command.name}`).join(" ")} /exit\n`
    );

    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- The chat reads one line at a time.
      const line = await nextLine(io);

      if (line === undefined || EXIT_LINES.has(line.trim())) {
        break;
      }

      if (line.trim() !== "") {
        // oxlint-disable-next-line no-await-in-loop -- Each line is handled before the next one is read.
        await handleLine(io, client, agent, state, line.trim());
      }
    }

    await state.idle;

    return 0;
  } catch (error) {
    io.stderr(`${errorMessage(error)}\n`);

    return 1;
  } finally {
    await client.close();
  }
};
