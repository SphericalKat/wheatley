import type { RpcEvent } from "@wheatley-ai/protocol";
import { BUILTIN_COMMANDS, parseCommandText } from "@wheatley-ai/sdk";

import { errorMessage } from "../core/error-message.js";
import { ChatState, isCliChatRun, track } from "./chat-state.js";
import type { DaemonClient } from "./client.js";
import type { CliIo } from "./io.js";
import {
  approvalQuestion,
  chooseAgent,
  connect,
  decideApproval,
} from "./session.js";
import type { ClientFlags } from "./session.js";
import { runInteractiveChat } from "./tui/run.js";

/** Lines that end the chat. */
const EXIT_LINES = new Set(["/exit", "/quit"]);

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

/**
 * `wheatley chat`: an interactive session in the Agent's CLI Chat (`cli` binding, Chat `default`), which the dashboard
 * shares (ADR 0007). Lines that start with a built-in command run it; `/exit` or the end of input ends the session
 * after the active Runs end. While an Approval waits, the next line answers it.
 *
 * On a terminal, the chat runs the interactive terminal app in `tui/`. Pipes and scripts get plain lines.
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
    const terminal = io.terminal?.();

    if (terminal !== undefined) {
      return await runInteractiveChat({
        agent,
        client,
        home: flags.home,
        streams: terminal,
        version,
      });
    }

    const state = new ChatState();

    client.onEvent((event) => {
      track(state, event);
      renderPlain(io, agent, event);
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
      const result = await io.lines.next();
      const line = result.done === true ? undefined : result.value.trim();

      if (line === undefined || EXIT_LINES.has(line)) {
        break;
      }

      if (line !== "") {
        // oxlint-disable-next-line no-await-in-loop -- Each line is handled before the next one is read.
        await handleLine(io, client, agent, state, line);
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
