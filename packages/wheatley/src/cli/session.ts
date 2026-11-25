import type { ApprovalDecision, PendingApproval } from "@wheatley/protocol";

import { daemonSocketPath } from "../core/daemon-socket.js";
import type { SocketEnv } from "../core/daemon-socket.js";
import { errorMessage } from "../core/error-message.js";
import { DaemonClient } from "./client.js";
import type { DaemonTarget } from "./client.js";
import type { CliIo } from "./io.js";

/** The flags that every client command shares. */
export interface ClientFlags {
  readonly home: string;
  /** A WebSocket URL, for example `ws://127.0.0.1:7420/ws`. The default is the Unix socket in the home folder. */
  readonly url: string | undefined;
  readonly agent: string | undefined;
}

/** The daemon address of the flags. Errors: throws if the home has no usable socket path (see `daemonSocketPath`). */
export const targetOf = (flags: ClientFlags, env: SocketEnv): DaemonTarget =>
  flags.url === undefined
    ? { socketPath: daemonSocketPath(flags.home, env) }
    : { url: flags.url };

/**
 * The Agent that a command talks to: `--agent`, else the only Agent, else the Agent named `default`. Errors: rejects if
 * the choice is ambiguous.
 */
export const chooseAgent = async (
  client: DaemonClient,
  requested: string | undefined
): Promise<string> => {
  if (requested !== undefined) {
    return requested;
  }

  const { agents } = await client.request("agents.list", {});
  const names = agents.map((agent) => agent.name);

  if (names.length === 1 && names[0] !== undefined) {
    return names[0];
  }

  if (names.includes("default")) {
    return "default";
  }

  throw new Error(
    `Choose an Agent with --agent: ${names.join(", ") || "no Agents exist"}`
  );
};

const DECISIONS = {
  a: "allow_always",
  always: "allow_always",
  c: "allow_conversation",
  conversation: "allow_conversation",
  d: "deny",
  deny: "deny",
  o: "allow_once",
  once: "allow_once",
} as const satisfies Readonly<Record<string, ApprovalDecision>>;

const isDecisionWord = (word: string): word is keyof typeof DECISIONS =>
  Object.hasOwn(DECISIONS, word);

/** The question that the CLI shows for an Approval. */
export const approvalQuestion = (approval: PendingApproval): string =>
  `Approval needed for ${approval.toolName}\n  input: ${approval.inputPreview}\nAllow? [o]nce, [c]onversation, [a]lways, [d]eny <reason>: `;

/** Parses an answer to `approvalQuestion`, or resolves `undefined` for an answer that is not a decision. */
export const parseApprovalAnswer = (
  answer: string
):
  | { readonly decision: ApprovalDecision; readonly reason: string | undefined }
  | undefined => {
  const [word = "", ...rest] = answer.trim().split(/\s+/u);
  const key = word.toLowerCase();

  if (!isDecisionWord(key)) {
    return undefined;
  }

  const decision: ApprovalDecision = DECISIONS[key];

  const reason = rest.join(" ");

  return {
    decision,
    reason: decision === "deny" && reason !== "" ? reason : undefined,
  };
};

/** Sends an answer to an Approval and reports the outcome. */
export const decideApproval = async (
  io: CliIo,
  client: DaemonClient,
  agent: string,
  approval: PendingApproval,
  answer: string
): Promise<boolean> => {
  const parsed = parseApprovalAnswer(answer);

  if (parsed === undefined) {
    io.stdout("Answer o, c, a, or d.\n");

    return false;
  }

  try {
    const { accepted } = await client.request("approvals.decide", {
      agent,
      approvalId: approval.approvalId,
      resolution: {
        decision: parsed.decision,
        reason: parsed.reason,
        resolvedBy: "cli",
      },
    });

    io.stdout(accepted ? "" : "The Approval already ended.\n");
  } catch (error) {
    io.stderr(`Cannot decide the Approval: ${errorMessage(error)}\n`);
  }

  return true;
};

/** Connects to the daemon, or explains how to start it. */
export const connect = async (
  io: CliIo,
  flags: ClientFlags,
  version: string
): Promise<DaemonClient | undefined> => {
  try {
    return await DaemonClient.connect(targetOf(flags, io.env), version);
  } catch (error) {
    io.stderr(
      `Cannot reach the Wheatley daemon (${errorMessage(error)}). Start it with "wheatley daemon".\n`
    );

    return undefined;
  }
};
