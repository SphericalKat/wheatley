import { RpcError } from "@wheatley-ai/protocol";
import type { ApprovalDecision, PendingApproval } from "@wheatley-ai/protocol";

import { daemonSocket } from "../core/daemon-socket.js";
import { errorMessage } from "../core/error-message.js";
import { startWheatley } from "../wiring/daemon.js";
import type { WheatleyDaemon, WheatleyOptions } from "../wiring/daemon.js";
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

/** The daemon address of the flags. */
export const targetOf = (flags: ClientFlags): DaemonTarget =>
  flags.url === undefined
    ? { socketPath: daemonSocket(flags.home).path }
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

/** Options for `connect`. */
export interface ConnectOptions {
  /** Starts an in-process daemon for this session when no local daemon listens. */
  readonly autoStart?: boolean;
  /** Overrides for the in-process daemon, for example a fake model provider in tests. */
  readonly daemonOverrides?: Partial<WheatleyOptions>;
}

/** An active daemon connection and the cleanup that ends it. */
export interface ConnectedSession {
  readonly client: DaemonClient;
  /** Closes the client connection and stops any in-process daemon started for this session. */
  readonly close: () => Promise<void>;
}

const ignoreLog = (): void => {
  // Ephemeral in-process daemons keep stdout and stderr clean for interactive chat and piped ask output.
};

const startEphemeralSession = async (
  io: CliIo,
  flags: ClientFlags,
  version: string,
  daemonOverrides: Partial<WheatleyOptions> | undefined
): Promise<ConnectedSession | undefined> => {
  let daemon: WheatleyDaemon;

  try {
    daemon = await startWheatley({
      env: io.env,
      homeDir: flags.home,
      port: 0,
      version,
      writeLog: ignoreLog,
      ...daemonOverrides,
    });
  } catch (error) {
    io.stderr(`Cannot start the Wheatley daemon: ${errorMessage(error)}\n`);

    return undefined;
  }

  try {
    const client = await DaemonClient.connect(
      { url: daemon.server.url },
      version
    );

    return {
      client,
      close: async () => {
        try {
          await client.close();
        } finally {
          await daemon.close();
        }
      },
    };
  } catch (error) {
    await daemon.close();
    io.stderr(`Cannot reach the Wheatley daemon (${errorMessage(error)}).\n`);

    return undefined;
  }
};

/**
 * Connects to the daemon. With `autoStart` and no `--url`, starts an in-process daemon for this session when no local
 * daemon listens, and stops it when `close` runs. Otherwise reports how to start the daemon.
 */
export const connect = async (
  io: CliIo,
  flags: ClientFlags,
  version: string,
  options: ConnectOptions = {}
): Promise<ConnectedSession | undefined> => {
  try {
    const client = await DaemonClient.connect(targetOf(flags), version);

    return {
      client,
      close: async () => {
        await client.close();
      },
    };
  } catch (error) {
    const canAutoStart =
      options.autoStart === true &&
      flags.url === undefined &&
      !(error instanceof RpcError);

    if (canAutoStart) {
      return await startEphemeralSession(
        io,
        flags,
        version,
        options.daemonOverrides
      );
    }

    io.stderr(
      `Cannot reach the Wheatley daemon (${errorMessage(error)}). Start it with "wheatley daemon".\n`
    );

    return undefined;
  }
};
