import type { PendingApproval, RpcEvent, RunSummary } from "@wheatley/protocol";

import { errorMessage } from "../core/error-message.js";
import type { CliIo } from "./io.js";
import { nextLine } from "./io.js";
import {
  approvalQuestion,
  chooseAgent,
  connect,
  decideApproval,
} from "./session.js";
import type { ClientFlags } from "./session.js";

/** The Run that `ask` follows, once the daemon named it. */
interface AskState {
  runId: string | undefined;
}

/** One event that `ask` waits for. */
type AskEvent =
  | { readonly kind: "reply"; readonly text: string }
  | { readonly kind: "approval"; readonly approval: PendingApproval }
  | { readonly kind: "finished"; readonly run: RunSummary };

/**
 * `wheatley ask <prompt>`: sends one prompt to the Agent's CLI Chat, prints the reply, and exits when the Run ends
 * (ADR 0005). Without a terminal, the Run is non-interactive and the gate denies every `ask` Tool (ADR 0011).
 *
 * Resolves with the exit code: 0 for a completed Run, 1 otherwise.
 */
export const runAsk = async (
  io: CliIo,
  flags: ClientFlags,
  prompt: string,
  version: string
): Promise<number> => {
  const client = await connect(io, flags, version);

  if (client === undefined) {
    return 1;
  }

  try {
    const agent = await chooseAgent(client, flags.agent);
    const queue: AskEvent[] = [];
    let wake = Promise.withResolvers<undefined>();
    const state: AskState = { runId: undefined };

    const push = (event: AskEvent): void => {
      queue.push(event);
      wake.resolve(undefined);
    };

    const backlog: RpcEvent[] = [];

    const route = (event: RpcEvent): void => {
      if (
        event.name === "chat.message" &&
        event.payload.message.runId === state.runId &&
        event.payload.message.role === "assistant"
      ) {
        push({ kind: "reply", text: event.payload.message.text });
      } else if (
        event.name === "approval.requested" &&
        event.payload.approval.runId === state.runId
      ) {
        push({ approval: event.payload.approval, kind: "approval" });
      } else if (
        event.name === "run.finished" &&
        event.payload.run.runId === state.runId
      ) {
        push({ kind: "finished", run: event.payload.run });
      }
    };

    client.onEvent((event) => {
      if (state.runId === undefined) {
        backlog.push(event);
      } else {
        route(event);
      }
    });
    await client.request("events.subscribe", {
      agents: [agent],
      topics: ["chat", "run", "approval"],
    });

    const sent = await client.request("chat.ask", {
      agent,
      interactive: io.isTTY,
      text: prompt,
    });

    state.runId = sent.runId;

    for (const event of backlog.splice(0)) {
      route(event);
    }

    for (;;) {
      const event = queue.shift();

      if (event === undefined) {
        // oxlint-disable-next-line no-await-in-loop -- The loop waits for the next event of the Run.
        await wake.promise;
        wake = Promise.withResolvers<undefined>();
        continue;
      }

      if (event.kind === "reply") {
        io.stdout(`${event.text}\n`);
      } else if (event.kind === "approval") {
        io.stdout(approvalQuestion(event.approval));
        // oxlint-disable-next-line no-await-in-loop -- The answer must arrive before the Run continues.
        const answer = await nextLine(io);

        // oxlint-disable-next-line no-await-in-loop -- The decision goes out before the next event is read.
        await decideApproval(
          io,
          client,
          agent,
          event.approval,
          answer ?? "deny"
        );
      } else {
        if (event.run.status !== "completed") {
          io.stderr(
            `The Run ended ${event.run.status}${event.run.error === undefined ? "" : `: ${event.run.error}`}\n`
          );
        }

        return event.run.status === "completed" ? 0 : 1;
      }
    }
  } catch (error) {
    io.stderr(`${errorMessage(error)}\n`);

    return 1;
  } finally {
    await client.close();
  }
};
