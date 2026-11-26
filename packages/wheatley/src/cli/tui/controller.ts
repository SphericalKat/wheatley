import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

import type {
  ApprovalDecision,
  PendingApproval,
  RpcEvent,
  RunSummary,
} from "@wheatley-ai/protocol";
import { parseCommandText } from "@wheatley-ai/sdk";

import { errorMessage } from "../../core/error-message.js";
import { ChatState, isCliChatRun, track } from "../chat-state.js";
import type { DaemonClient } from "../client.js";
import { shuffledThinkingLines } from "../personality.js";
import {
  LOCAL_COMMANDS,
  isCommandLine,
  matchCommands,
  suggestCommand,
} from "./commands.js";
import { createMarkdownRenderer, renderMarkdown } from "./markdown.js";
import type { MarkdownLine } from "./markdown.js";

/** The parts of the daemon client that the chat uses. */
export type ChatClient = Pick<DaemonClient, "onEvent" | "request">;

/** One block of the transcript. The transcript only grows, so the terminal prints each entry once. */
export type Entry =
  | { readonly id: number; readonly kind: "banner" }
  | { readonly id: number; readonly kind: "user"; readonly text: string }
  /** Rendered Markdown of a reply. `first` marks the first block of a reply, which gets the logo. */
  | {
      readonly id: number;
      readonly kind: "reply";
      readonly lines: readonly MarkdownLine[];
      readonly first: boolean;
    }
  | {
      readonly id: number;
      readonly kind: "tool";
      readonly name: string;
      readonly input: string;
      readonly ok: boolean;
      readonly output: string;
      readonly seconds: number;
    }
  | {
      readonly id: number;
      readonly kind: "turn";
      readonly seconds: number;
      readonly tools: number;
      readonly usage: RunSummary["usage"];
    }
  | {
      readonly id: number;
      readonly kind: "notice";
      readonly tone: "dim" | "error" | "warning";
      readonly text: string;
    }
  | { readonly id: number; readonly kind: "help" }
  | { readonly id: number; readonly kind: "shell"; readonly text: string };

/** What the Agent or the terminal does right now. */
export type Activity =
  | { readonly kind: "thinking"; readonly startedAt: number }
  | {
      readonly kind: "tool";
      readonly name: string;
      readonly input: string;
      readonly startedAt: number;
    }
  | {
      readonly kind: "shell";
      readonly command: string;
      readonly startedAt: number;
    };

export interface SessionUsage {
  readonly runs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
}

/** Everything the terminal shows. The controller replaces the whole object on each change. */
export interface ChatView {
  readonly agent: string;
  readonly entries: readonly Entry[];
  /** The rendered, unfinished last line of a streamed reply, or no lines. */
  readonly live: readonly MarkdownLine[];
  readonly activity: Activity | undefined;
  readonly approval: PendingApproval | undefined;
  readonly model: string | undefined;
  readonly extensions: string | undefined;
  readonly usage: SessionUsage;
  readonly thinkingLines: readonly string[];
}

export interface ChatControllerOptions {
  readonly agent: string;
  readonly client: ChatClient;
  /** Writes a terminal control sequence that prints no text, for example a bell or a clipboard copy. */
  readonly control: (sequence: string) => void;
  readonly now?: () => number;
}

const MS_PER_SECOND = 1000;

/** A Run that takes at least this long rings the bell when it ends. */
const NOTIFY_AFTER_MS = 10_000;
const SHELL_PREFIX = "!";
const BELL = "\u0007";
const OSC = "\u001B]";

const notification = (text: string): string => `${OSC}9;${text}${BELL}${BELL}`;

const ofRunEvent = (
  event: RpcEvent,
  runs: ReadonlySet<string>
): string | undefined => {
  if (
    event.name === "run.delta" ||
    event.name === "run.toolStarted" ||
    event.name === "run.toolFinished"
  ) {
    return runs.has(event.payload.runId) ? event.payload.runId : undefined;
  }

  return undefined;
};

/** Drives one interactive chat: daemon events in, transcript and live view out. */
export class ChatController {
  readonly #options: ChatControllerOptions;
  readonly #state = new ChatState();
  readonly #listeners = new Set<() => void>();
  readonly #runs = new Set<string>();
  /** IDs of messages that this chat sent, until the daemon echoes them. */
  readonly #sent = new Set<string>();
  /** Texts of `chat.send` requests without a response. Their echo can arrive before the response. */
  readonly #inFlight: string[] = [];
  /** IDs of own messages whose echo arrived before the `chat.send` response. */
  readonly #echoedEarly = new Set<string>();
  readonly #toolStarts = new Map<string, number>();
  /** Runs whose final reply arrived. Their late deltas are already part of the shown reply. */
  readonly #replyDone = new Set<string>();
  readonly #now: () => number;
  #view: ChatView;
  #nextId = 0;
  #buffer = "";
  #streamed = "";
  #renderLine = createMarkdownRenderer();
  #replyStarted = false;
  #runStartedAt: number | undefined;
  #tools = 0;
  #lastReply = "";
  #shell: ChildProcess | undefined;

  constructor(options: ChatControllerOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#view = {
      activity: undefined,
      agent: options.agent,
      approval: undefined,
      entries: [{ id: this.#id(), kind: "banner" }],
      extensions: undefined,
      live: [],
      model: undefined,
      thinkingLines: shuffledThinkingLines(),
      usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, runs: 0 },
    };
  }

  /** The current view. React reads it through `useSyncExternalStore`. */
  readonly view = (): ChatView => this.#view;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);

    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** True while a Run of this chat or a shell command works. */
  get busy(): boolean {
    return this.#state.busy || this.#shell !== undefined;
  }

  /** Resolves when no Run of this chat is active. */
  get idle(): Promise<undefined> {
    return this.#state.idle;
  }

  /** Subscribes to the daemon events and loads the model and extension counts for the banner. */
  readonly start = async (): Promise<void> => {
    const { agent, client } = this.#options;

    client.onEvent((event) => {
      this.#onEvent(event);
    });
    await client.request("events.subscribe", {
      agents: [agent],
      topics: ["chat", "run", "approval"],
    });

    try {
      const { config } = await client.request("config.get", {});
      const model = config.agents[agent]?.model;

      if (model !== undefined) {
        this.#update({ model: `${model.provider}/${model.id}` });
      }

      const extensions = await client.request("extensions.list", { agent });

      this.#update({
        extensions: `${extensions.skills.length} skills · ${extensions.plugins.length} plugins · ${extensions.mcpServers.length} MCP servers`,
      });
    } catch {
      // The banner works without these details.
    }
  };

  /**
   * Handles one submitted line. Returns `"exit"` if the chat must end.
   *
   * Errors: never rejects. A failed request becomes an error entry.
   */
  readonly submit = async (raw: string): Promise<"exit" | undefined> => {
    const line = raw.trim();

    if (line === "") {
      return undefined;
    }

    if (line === LOCAL_COMMANDS.exit || line === LOCAL_COMMANDS.quit) {
      return "exit";
    }

    this.#append({ kind: "user", text: line });

    try {
      await this.#dispatch(line);
    } catch (error) {
      this.#append({
        kind: "notice",
        text: `✗ ${errorMessage(error)}`,
        tone: "error",
      });
    }

    return undefined;
  };

  /** Answers the open Approval. */
  readonly decide = async (
    decision: ApprovalDecision,
    reason?: string
  ): Promise<void> => {
    const { approval } = this.#view;

    if (approval === undefined) {
      return;
    }

    this.#state.removeApproval(approval.approvalId);
    this.#refreshStatus();

    try {
      const { accepted } = await this.#options.client.request(
        "approvals.decide",
        {
          agent: this.#options.agent,
          approvalId: approval.approvalId,
          resolution: { decision, reason, resolvedBy: "cli" },
        }
      );

      if (!accepted) {
        this.#append({
          kind: "notice",
          text: "The Approval already ended.",
          tone: "dim",
        });
      }
    } catch (error) {
      this.#append({
        kind: "notice",
        text: `✗ Cannot decide the Approval: ${errorMessage(error)}`,
        tone: "error",
      });
    }
  };

  /** Stops the shell command or the active Run. Returns false if nothing was running. */
  readonly interrupt = (): boolean => {
    if (this.#shell !== undefined) {
      this.#shell.kill("SIGINT");

      return true;
    }

    if (!this.#state.busy) {
      return false;
    }

    this.#append({ kind: "notice", text: "Stopping the Run…", tone: "dim" });
    this.#options.client
      .request("chat.command", { agent: this.#options.agent, name: "stop" })
      .catch(() => {
        // The Run can end before the request arrives.
      });

    return true;
  };

  readonly #dispatch = async (line: string): Promise<void> => {
    if (line.startsWith(SHELL_PREFIX)) {
      this.#runShell(line.slice(SHELL_PREFIX.length).trim());

      return;
    }

    if (line === LOCAL_COMMANDS.help) {
      this.#append({ kind: "help" });

      return;
    }

    if (line === LOCAL_COMMANDS.copy) {
      this.#copyLastReply();

      return;
    }

    const command = parseCommandText(line);

    if (command !== undefined) {
      await this.#options.client.request("chat.command", {
        agent: this.#options.agent,
        args: command.args,
        name: command.name,
      });

      return;
    }

    if (isCommandLine(line)) {
      const [word = line] = line.split(" ");
      const suggestion = suggestCommand(word) ?? matchCommands(word)[0]?.word;

      this.#append({
        kind: "notice",
        text:
          suggestion === undefined
            ? `Unknown command ${word}. Nothing was sent. Type /help for the commands.`
            : `Unknown command ${word}. Nothing was sent. Did you mean ${suggestion}?`,
        tone: "warning",
      });

      return;
    }

    this.#inFlight.push(line);

    const { messageId } = await this.#options.client
      .request("chat.send", { agent: this.#options.agent, text: line })
      .finally(() => {
        const index = this.#inFlight.indexOf(line);

        if (index !== -1) {
          this.#inFlight.splice(index, 1);
        }
      });

    if (!this.#echoedEarly.delete(messageId)) {
      this.#sent.add(messageId);
    }

    this.#state.sent(messageId);
    this.#refreshStatus();
  };

  readonly #runShell = (command: string): void => {
    if (command === "") {
      this.#append({
        kind: "notice",
        text: "Type a command after !, for example !ls.",
        tone: "dim",
      });

      return;
    }

    if (this.#shell !== undefined) {
      this.#append({
        kind: "notice",
        text: "A shell command is already running.",
        tone: "warning",
      });

      return;
    }

    const startedAt = this.#now();

    const child = spawn(process.env.SHELL ?? "/bin/sh", ["-c", command], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.#shell = child;
    this.#update({ activity: { command, kind: "shell", startedAt } });

    let pending = "";

    const onData = (chunk: Buffer): void => {
      pending += chunk.toString("utf-8");

      const end = pending.lastIndexOf("\n");

      if (end !== -1) {
        this.#append({ kind: "shell", text: pending.slice(0, end) });
        pending = pending.slice(end + 1);
      }
    };

    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (error) => {
      this.#append({
        kind: "notice",
        text: `✗ ${error.message}`,
        tone: "error",
      });
    });
    child.on("close", (code, signal) => {
      if (pending !== "") {
        this.#append({ kind: "shell", text: pending });
      }

      this.#shell = undefined;

      const seconds = ((this.#now() - startedAt) / MS_PER_SECOND).toFixed(1);

      const status =
        signal === null ? `exit ${code ?? 0}` : `stopped by ${signal}`;

      this.#append({
        kind: "notice",
        text: `${status} · ${seconds}s`,
        tone: code === 0 ? "dim" : "warning",
      });
      this.#refreshStatus();
    });
  };

  readonly #copyLastReply = (): void => {
    if (this.#lastReply === "") {
      this.#append({
        kind: "notice",
        text: "There is no reply to copy yet.",
        tone: "dim",
      });

      return;
    }

    // OSC 52 asks the terminal to set the clipboard. It also works over SSH.
    this.#options.control(
      `${OSC}52;c;${Buffer.from(this.#lastReply).toString("base64")}${BELL}`
    );
    this.#append({
      kind: "notice",
      text: "Copied the last reply.",
      tone: "dim",
    });
  };

  readonly #onEvent = (event: RpcEvent): void => {
    track(this.#state, event);

    if (isCliChatRun(event) && event.name === "run.started") {
      this.#runs.add(event.payload.run.runId);
      this.#runStartedAt = this.#now();
      this.#tools = 0;
      this.#update({ thinkingLines: shuffledThinkingLines() });
    } else if (isCliChatRun(event) && event.name === "run.finished") {
      this.#finishRun(event.payload.run);
    } else if (ofRunEvent(event, this.#runs) !== undefined) {
      this.#onRunEvent(event);
    } else if (event.name === "chat.message") {
      this.#onMessage(event.payload.message);
    } else if (event.name === "approval.requested") {
      this.#options.control(
        notification(`${event.payload.approval.toolName} needs approval`)
      );
    }

    this.#refreshStatus();
  };

  readonly #onRunEvent = (event: RpcEvent): void => {
    if (event.name === "run.delta") {
      if (!this.#replyDone.has(event.payload.runId)) {
        this.#stream(event.payload.delta);
      }
    } else if (event.name === "run.toolStarted") {
      this.#endSegment();
      this.#toolStarts.set(event.payload.toolCallId, this.#now());
      this.#update({
        activity: {
          input: event.payload.inputPreview,
          kind: "tool",
          name: event.payload.toolName,
          startedAt: this.#now(),
        },
      });
    } else if (event.name === "run.toolFinished") {
      const startedAt =
        this.#toolStarts.get(event.payload.toolCallId) ?? this.#now();

      this.#toolStarts.delete(event.payload.toolCallId);
      this.#tools += 1;

      const { activity } = this.#view;

      this.#append({
        input: activity?.kind === "tool" ? activity.input : "",
        kind: "tool",
        name: event.payload.toolName,
        ok: !event.payload.isError,
        output: event.payload.outputPreview,
        seconds: (this.#now() - startedAt) / MS_PER_SECOND,
      });
      this.#update({
        activity: {
          kind: "thinking",
          startedAt: this.#runStartedAt ?? this.#now(),
        },
      });
    }
  };

  readonly #onMessage = (message: {
    readonly messageId: string;
    readonly role: "assistant" | "user";
    readonly runId?: string;
    readonly text: string;
  }): void => {
    if (message.role === "user") {
      // Messages that the dashboard sends to the same Chat show up here too.
      if (this.#sent.delete(message.messageId)) {
        return;
      }

      const inFlight = this.#inFlight.indexOf(message.text);

      if (inFlight === -1) {
        this.#append({ kind: "user", text: message.text });
      } else {
        this.#inFlight.splice(inFlight, 1);
        this.#echoedEarly.add(message.messageId);
      }

      return;
    }

    this.#lastReply = message.text;

    const ownRun =
      message.runId !== undefined && this.#runs.has(message.runId)
        ? message.runId
        : undefined;

    if (ownRun !== undefined) {
      // The final text can arrive before the last deltas. Print the part that the stream has not shown yet, and
      // ignore the deltas that arrive after it.
      this.#replyDone.add(ownRun);

      if (this.#streamed !== "" && message.text.startsWith(this.#streamed)) {
        this.#stream(message.text.slice(this.#streamed.length));
        this.#endSegment();

        return;
      }
    }

    this.#endSegment();
    this.#append({
      first: true,
      kind: "reply",
      lines: renderMarkdown(message.text),
    });
  };

  readonly #stream = (delta: string): void => {
    this.#buffer += delta;
    this.#streamed += delta;

    const end = this.#buffer.lastIndexOf("\n");

    if (end !== -1) {
      const lines = this.#buffer.slice(0, end).split("\n");

      this.#buffer = this.#buffer.slice(end + 1);
      this.#appendReply(lines.map((line) => this.#renderLine(line)));
    }

    this.#update({ live: this.#buffer === "" ? [] : [this.#renderPreview()] });
  };

  /** Renders the unfinished line without changing the renderer's code-fence state. */
  readonly #renderPreview = (): MarkdownLine => {
    const preview = createMarkdownRenderer();

    return preview(this.#buffer);
  };

  readonly #appendReply = (lines: readonly MarkdownLine[]): void => {
    this.#append({ first: !this.#replyStarted, kind: "reply", lines });
    this.#replyStarted = true;
  };

  /** Ends the current streamed text block, for example before a Tool call or at the end of a reply. */
  readonly #endSegment = (): void => {
    if (this.#buffer !== "") {
      this.#appendReply([this.#renderLine(this.#buffer)]);
    }

    this.#buffer = "";
    this.#streamed = "";
    this.#renderLine = createMarkdownRenderer();
    this.#replyStarted = false;
    this.#update({ live: [] });
  };

  readonly #finishRun = (run: RunSummary): void => {
    this.#endSegment();

    const startedAt = this.#runStartedAt ?? this.#now();
    const elapsed = this.#now() - startedAt;
    const { usage } = this.#view;

    this.#runs.delete(run.runId);
    this.#replyDone.delete(run.runId);
    this.#runStartedAt = undefined;

    if (run.status === "failed") {
      this.#append({
        kind: "notice",
        text: `✗ The Run failed: ${run.error ?? "unknown error"}`,
        tone: "error",
      });
    }

    // One update, so a listener never sees the turn footer with a stale spinner or with the usage before it.
    this.#update({
      activity:
        this.#shell === undefined && !this.#state.busy
          ? undefined
          : this.#view.activity,
      entries: [
        ...this.#view.entries,
        {
          id: this.#id(),
          kind: "turn",
          seconds: elapsed / MS_PER_SECOND,
          tools: this.#tools,
          usage: run.usage,
        },
      ],
      model: run.model ?? this.#view.model,
      usage: {
        costUsd: usage.costUsd + (run.usage?.costUsd ?? 0),
        inputTokens: usage.inputTokens + (run.usage?.inputTokens ?? 0),
        outputTokens: usage.outputTokens + (run.usage?.outputTokens ?? 0),
        runs: usage.runs + 1,
      },
    });

    if (elapsed >= NOTIFY_AFTER_MS) {
      this.#options.control(notification(`${this.#options.agent} finished`));
    }
  };

  /** Keeps the open Approval and the activity in step with the chat state. */
  readonly #refreshStatus = (): void => {
    const [approval] = this.#state.approvals;
    let { activity } = this.#view;

    if (this.#shell === undefined && !this.#state.busy) {
      activity = undefined;
    } else if (this.#shell === undefined && activity === undefined) {
      activity = {
        kind: "thinking",
        startedAt: this.#runStartedAt ?? this.#now(),
      };
    }

    if (approval !== this.#view.approval || activity !== this.#view.activity) {
      this.#update({ activity, approval });
    }
  };

  readonly #id = (): number => {
    this.#nextId += 1;

    return this.#nextId;
  };

  readonly #append = (entry: DistributiveOmit<Entry, "id">): void => {
    this.#update({
      entries: [...this.#view.entries, { ...entry, id: this.#id() }],
    });
  };

  readonly #update = (changes: Partial<ChatView>): void => {
    this.#view = { ...this.#view, ...changes };

    for (const listener of this.#listeners) {
      listener();
    }
  };
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;
