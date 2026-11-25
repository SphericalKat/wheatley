import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import type { Models } from "@earendil-works/pi-ai";
import {
  parseDuration,
  TOOL_INPUT_PREVIEW_MAX_LENGTH,
  TOOL_OUTPUT_PREVIEW_MAX_LENGTH,
} from "@wheatley/protocol";
import type {
  MethodResult,
  AgentConfig,
  BindingStatus,
  ChatKey,
  ChatMessage,
  CommandName,
  ExtensionStatus,
  ModelChoice,
  RunOrigin,
  RunTimelineItem,
  ToolInfo,
} from "@wheatley/protocol";
import type { Logger, SecretReader, ToolResult } from "@wheatley/sdk";

import type { ApprovalGate } from "../../contracts/approval-gate.js";
import type { DeliveryOutbox } from "../../contracts/delivery-outbox.js";
import { SeamError } from "../../contracts/errors.js";
import type {
  AgentExtensions,
  ExtensionCatalog,
} from "../../contracts/extension-catalog.js";
import type {
  MaintenanceRunner,
  MaintenanceRunResult,
} from "../../contracts/maintenance-runner.js";
import type {
  ArchivedMessage,
  MemoryStore,
} from "../../contracts/memory-store.js";
import type {
  AgentModuleContext,
  Clock,
  EventSink,
  RpcHandlerMap,
} from "../../contracts/module.js";
import type { TriggerRunner } from "../../contracts/trigger-runtime.js";
import { openAgentDatabase } from "../../db/database.js";
import { runMigrations } from "../../db/migrations.js";
import type { MigrationNamespace } from "../../db/migrations.js";
import { ConcurrencyGate } from "../concurrency-gate.js";
import { SerialQueue } from "../config/atomic-file.js";
import { CLI_BINDING_ID } from "../config/validate.js";
import { errorMessage } from "../error-message.js";
import { AgentStore, CORE_NAMESPACE, coreMigrations } from "./agent-store.js";
import type { RunDelivery } from "./agent-store.js";
import { openPiAdapter } from "./pi-adapter.js";
import type {
  PiAdapter,
  PiGateVerdict,
  PiRunOutcome,
  PiToolCall,
} from "./pi-adapter.js";
import { createPolicyOnlyGate, evaluatePolicy } from "./policy-gate.js";
import type { ApprovalGateFactory } from "./policy-gate.js";

/** The Chat ID of the CLI Chat, which the dashboard shares (ADR 0007). */
export const CLI_CHAT_ID = "default";

/** The CLI Chat of every Agent. */
export const CLI_CHAT: ChatKey = {
  bindingId: CLI_BINDING_ID,
  chatId: CLI_CHAT_ID,
};

/** The default Approval timeout (ADR 0011). */
export const DEFAULT_APPROVAL_TIMEOUT = "15m";

/** The default limit of concurrent Runs of one Agent without `maxConcurrentRuns`. */
export const DEFAULT_MAX_CONCURRENT_RUNS = 4;

/** The file name of the pi-durable storage inside the Agent folder (ADR 0001). */
export const HARNESS_FILE = "harness.sqlite";

/** The file name of the Agent's module database inside the Agent folder. */
export const AGENT_DB_FILE = "agent.sqlite";

/** The working directory of the Agent's Tools, inside the Agent folder. */
export const WORKSPACE_DIR = "workspace";

const isCliChat = (chat: ChatKey | null): boolean =>
  chat?.bindingId === CLI_CHAT.bindingId && chat.chatId === CLI_CHAT.chatId;

const preview = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

const resultText = (result: ToolResult): string =>
  result.content
    .map((block) =>
      block.type === "text" ? block.text : `[image ${block.mimeType}]`
    )
    .join("\n");

const deliveryFor = (
  chat: ChatKey,
  source: RunDelivery["source"]
): RunDelivery | null =>
  isCliChat(chat)
    ? null
    : { bindingId: chat.bindingId, chatId: chat.chatId, source };

/** What hosted modules get from the Agent besides their own context. */
export interface AgentHost {
  readonly maintenance: MaintenanceRunner;
  readonly triggers: TriggerRunner;
  readonly approvals: ApprovalGate;
}

/** A module that the Agent hosts: it runs its migrations, creates it, mounts its JSON-RPC handlers, and starts it. */
export interface HostedModule {
  readonly migrations: MigrationNamespace;
  /** Creates the module. The Agent calls it once, after it applies every migration. */
  readonly mount: (
    ctx: AgentModuleContext,
    host: AgentHost
  ) => Promise<MountedModule>;
}

/** A created hosted module without its typed API. */
export interface MountedModule {
  readonly rpc: RpcHandlerMap;
  readonly start?: () => Promise<void>;
  readonly stop?: () => Promise<void>;
}

/** Everything that one Agent needs from the Deployment. */
export interface AgentOptions {
  readonly name: string;
  /** `~/.wheatley/agents/<name>/`. */
  readonly agentDir: string;
  readonly homeDir: string;
  readonly config: AgentConfig;
  /** Model access for every Conversation. The Deployment passes a Concurrency Gate wrapper. */
  readonly models: Models;
  readonly extensions: ExtensionCatalog;
  readonly secrets: SecretReader & {
    readonly redact: (text: string) => string;
  };
  readonly events: EventSink;
  readonly log: Logger;
  readonly clock: Clock;
  /** Creates the Approval gate. Without it, the Agent denies every `ask` Tool. */
  readonly approvals?: ApprovalGateFactory;
  /** The outbox for replies to Chats other than the CLI Chat. Without it, the Agent logs and drops such replies. */
  readonly outbox?: Pick<DeliveryOutbox, "enqueue">;
  /** The Memory snapshot, the pre-compaction flush, and the Conversation archive (ADR 0009). */
  readonly memory?: Pick<
    MemoryStore,
    "snapshot" | "compactionFlushPrompt" | "archive"
  >;
  /** True if a Trigger Run called `suppress_delivery`. */
  readonly isDeliverySuppressed?: (runId: string) => Promise<boolean>;
  readonly modules?: readonly HostedModule[];
  /** `/restart` asks the Supervisor to restart this Agent. */
  readonly onRestartRequested: () => void;
  /** The Harness failed after a storage error. The Supervisor restarts the Agent. */
  readonly onFailed: (error: Error) => void;
}

/** A Run that the Agent drives. */
interface ActiveRun {
  readonly runId: string;
  readonly conversationId: string;
  readonly chat: ChatKey | null;
  readonly origin: RunOrigin;
  readonly interactive: boolean;
  readonly controller: AbortController;
  readonly done: PromiseWithResolvers<MaintenanceRunResult>;
}

/** The Run that drives a Conversation now. `runId` is empty if no Run drives it. */
interface RunLookup {
  readonly runId: string;
  readonly run: ActiveRun | undefined;
}

/** Holds the adapter of the Harness once it is open. */
interface AdapterHolder {
  adapter: PiAdapter | undefined;
}

/** A Run to start. */
interface RunSpec {
  readonly conversationId: string;
  readonly origin: RunOrigin;
  readonly chat: ChatKey | null;
  readonly interactive: boolean;
  readonly prompt: string;
  /** The user message to store and show, or `undefined` for a Run without one (Trigger and maintenance Runs). */
  readonly userMessage:
    | { readonly text: string; readonly senderDisplayName: string | undefined }
    | undefined;
  readonly delivery: RunDelivery | null;
}

/** The result of `send` and `ask`. */
export interface SentMessage {
  readonly messageId: string;
  readonly runId: string;
  readonly conversationId: string;
}

/** Input of `send`. */
export interface ChatInput {
  readonly text: string;
  readonly senderDisplayName?: string;
  /** False for a CLI without a TTY. The gate then denies every `ask` Tool (ADR 0011). */
  readonly interactive: boolean;
}

/** Health fields that the Agent reports to the Supervisor. */
export interface AgentStatus {
  readonly activeRuns: number;
  readonly frontends: readonly BindingStatus[];
  readonly plugins: readonly ExtensionStatus[];
  readonly mcpServers: readonly ExtensionStatus[];
  readonly skillWarnings: readonly string[];
}

const parseModelArgument = (
  argument: string,
  current: ModelChoice
): ModelChoice => {
  const slash = argument.indexOf("/");

  return slash === -1
    ? { id: argument, provider: current.provider }
    : { id: argument.slice(slash + 1), provider: argument.slice(0, slash) };
};

/**
 * One running Agent: its `agent.sqlite`, its pi-durable Harness over `harness.sqlite`, its extensions, and its Runs
 * (ADR 0001, ADR 0003). Agents share nothing except the Deployment's model access, so one Agent's failure leaves the
 * others running.
 *
 * Ordering: `open` applies every migration, creates extensions and modules, opens the Harness, starts modules, and then
 * continues the Runs that the last process left active.
 */
export class Agent {
  readonly name: string;
  readonly #options: AgentOptions;
  readonly #db: DatabaseSync;
  readonly #store: AgentStore;
  readonly #extensions: AgentExtensions;
  readonly #gate: ApprovalGate;
  readonly #runSlots: ConcurrencyGate;
  readonly #workspaceDir: string;
  readonly #active = new Map<string, ActiveRun>();
  readonly #runByConversation = new Map<string, string>();
  readonly #conversationQueues = new Map<string, SerialQueue>();
  readonly #rpc: RpcHandlerMap[] = [];
  readonly #stops: (() => Promise<void>)[] = [];
  readonly #pendingStarts: ((() => Promise<void>) | undefined)[] = [];
  #pi: PiAdapter | undefined;
  #closed = false;

  private constructor(
    options: AgentOptions,
    db: DatabaseSync,
    extensions: AgentExtensions,
    gate: ApprovalGate
  ) {
    this.name = options.name;
    this.#options = options;
    this.#db = db;
    this.#store = new AgentStore(db, options.name);
    this.#extensions = extensions;
    this.#gate = gate;
    this.#workspaceDir = path.join(options.agentDir, WORKSPACE_DIR);
    this.#runSlots = new ConcurrencyGate(
      () => options.config.maxConcurrentRuns ?? DEFAULT_MAX_CONCURRENT_RUNS
    );
  }

  /**
   * Opens the Agent. Errors: rejects if a migration fails, the extensions cannot load, a module cannot be created, or
   * the Harness cannot open. Everything opened so far is closed again before the promise rejects.
   */
  static async open(options: AgentOptions): Promise<Agent> {
    await mkdir(path.join(options.agentDir, WORKSPACE_DIR), {
      recursive: true,
    });
    const db = openAgentDatabase(path.join(options.agentDir, AGENT_DB_FILE));
    let agent: Agent | undefined;

    try {
      runMigrations(db, [
        { migrations: coreMigrations, namespace: CORE_NAMESPACE },
        ...(options.modules ?? []).map((module) => module.migrations),
      ]);

      const abort = new AbortController();

      const extensions = await options.extensions.createAgentExtensions({
        agentDir: options.agentDir,
        agentName: options.name,
        config: options.config,
        homeDir: options.homeDir,
        log: options.log,
        secrets: options.secrets,
        signal: abort.signal,
      });

      // The gate exists before the Harness, and the Harness's wake exists after it, so the gate wakes through this.
      const harness: AdapterHolder = { adapter: undefined };

      const { approvalTimeout } = options.config;

      const timeout =
        approvalTimeout === undefined
          ? DEFAULT_APPROVAL_TIMEOUT
          : approvalTimeout;

      const gateFactory = options.approvals ?? createPolicyOnlyGate;

      const gate = gateFactory({
        agentName: options.name,
        clock: options.clock,
        defaultAction: (toolName) =>
          extensions
            .tools()
            .find((tool) => tool.name === toolName && tool.source === "builtin")
            ?.defaultAction,
        events: options.events,
        policy: options.config.permissionPolicy ?? [],
        timeoutMs: timeout === null ? null : parseDuration(timeout),
        wake: async (calls) => {
          await harness.adapter?.wake(calls);
        },
      });

      agent = new Agent(options, db, extensions, gate);
      agent.#stops.push(async () => {
        abort.abort();
        await extensions.close();
      });
      await agent.#mountModules();

      harness.adapter = await agent.#openPi();
      await agent.#startModules();
      agent.#resumeRuns();

      return agent;
    } catch (error) {
      if (agent === undefined) {
        db.close();
      } else {
        await agent.close();
      }

      throw error;
    }
  }

  /** The JSON-RPC handlers of the hosted modules, in mount order. The core handlers come from `createAgentRpc`. */
  get moduleRpc(): readonly RpcHandlerMap[] {
    return this.#rpc;
  }

  /** The Agent's `ApprovalGate`. */
  get approvals(): ApprovalGate {
    return this.#gate;
  }

  /** The Agent's maintenance Run starter (ADR 0009). */
  get maintenance(): MaintenanceRunner {
    return { start: this.#startMaintenance, wait: this.#waitRun };
  }

  /** The Agent's Trigger Run starter (ADR 0010). */
  get triggers(): TriggerRunner {
    return { isActive: this.#isTriggerActive, start: this.#startTrigger };
  }

  /** Health fields for `agents.get` and `system.status`. */
  readonly status = (): AgentStatus => {
    const health = this.#extensions.health();

    return {
      activeRuns: this.#active.size,
      frontends: [{ id: CLI_BINDING_ID, state: "ready", type: "cli" }],
      mcpServers: health.mcpServers,
      plugins: health.plugins,
      skillWarnings: health.skillWarnings,
    };
  };

  /** The Tools of the Agent with the action of the Permission Policy in `config.yaml`, for `extensions.list`. */
  readonly tools = (): ToolInfo[] =>
    this.#extensions.tools().map((tool) => ({
      action: evaluatePolicy(
        this.#options.config.permissionPolicy ?? [],
        tool.name,
        tool.defaultAction
      ),
      description: tool.description,
      name: tool.name,
      source: tool.source,
    }));

  /** The extensions of the Agent for `extensions.list`. */
  get extensions(): AgentExtensions {
    return this.#extensions;
  }

  /**
   * Stores a user message for `chat`, starts its Run, and resolves once both are stored. The reply arrives as a
   * `chat.message` event for the CLI Chat, or through the outbox for any other Chat.
   */
  readonly send = async (
    chat: ChatKey,
    input: ChatInput
  ): Promise<SentMessage> => {
    const conversationId = await this.#chatConversation(chat);

    return await this.#startRun({
      chat,
      conversationId,
      delivery: deliveryFor(chat, "reply"),
      interactive: input.interactive,
      origin: { bindingId: chat.bindingId, chatId: chat.chatId, kind: "chat" },
      prompt: input.text,
      userMessage: {
        senderDisplayName: input.senderDisplayName,
        text: input.text,
      },
    });
  };

  /**
   * Runs a built-in command for `chat` (ADR 0007). Resolves `false` if the command cannot run, for example `/model`
   * without an argument or `/stop` without an active Run. A command reply arrives like a Run reply, with source
   * `command`.
   */
  readonly command = async (
    chat: ChatKey,
    name: CommandName,
    args: string | undefined
  ): Promise<boolean> => {
    switch (name) {
      case "new": {
        return await this.#newConversation(chat);
      }

      case "model": {
        return await this.#changeModel(chat, args);
      }

      case "compact": {
        return await this.#compact(chat);
      }

      case "stop": {
        return await this.#stopChat(chat);
      }

      case "goal": {
        return await this.#goal(chat, args);
      }

      case "status": {
        return await this.#reportStatus(chat);
      }

      case "restart": {
        await this.#reply(chat, "Restarting this Agent.");
        this.#options.onRestartRequested();

        return true;
      }

      default: {
        return false;
      }
    }
  };

  /** Messages of the Chat's current Conversation, oldest first, before `before`. */
  readonly history = async (
    chat: ChatKey,
    before: string | undefined,
    limit: number
  ): Promise<MethodResult<"chat.history">> => {
    const conversationId = await this.#chatConversation(chat);
    const rows = this.#store.chatMessages(conversationId, before, limit);
    const hasMore = rows.length > limit;

    return {
      conversationId,
      hasMore,
      messages: hasMore ? rows.slice(1) : rows,
    };
  };

  /** Runs newest first. */
  readonly listRuns = (options: {
    readonly before: string | undefined;
    readonly limit: number;
    readonly activeOnly: boolean;
  }): MethodResult<"runs.list"> => {
    const rows = this.#store.listRuns(options);
    const hasMore = rows.length > options.limit;

    return { hasMore, runs: hasMore ? rows.slice(0, options.limit) : rows };
  };

  /** One Run and its timeline. Throws `SeamError("not_found")` for an unknown Run. */
  readonly getRun = (runId: string): MethodResult<"runs.get"> => {
    const stored = this.#store.getRun(runId);

    if (stored === undefined) {
      throw new SeamError("not_found", `Unknown Run: ${runId}`);
    }

    return { run: stored.summary, timeline: this.#store.timeline(runId) };
  };

  /** Stops an active Run: cancels its Approvals and stops its Conversation's work. Resolves `false` if it ended. */
  readonly stopRun = async (runId: string): Promise<boolean> => {
    const run = this.#active.get(runId);

    if (run === undefined || this.#pi === undefined) {
      return false;
    }

    run.controller.abort(new Error("The Run was stopped"));
    await this.#gate.cancelRun(runId);

    // A Run that still waits behind another Run of its Conversation ends when its turn comes, because its signal
    // aborted. Only the Run that drives the Conversation stops the Conversation's work.
    if (this.#runByConversation.get(run.conversationId) === runId) {
      await this.#pi.stop(run.conversationId);
    }

    return true;
  };

  /**
   * Stops modules in reverse order, closes the Harness, the extensions, and `agent.sqlite`. Active Runs stay active in
   * storage and continue at the next `open`. Repeated calls do nothing.
   */
  readonly close = async (): Promise<void> => {
    if (this.#closed) {
      return;
    }

    this.#closed = true;

    for (const run of this.#active.values()) {
      run.controller.abort(new Error("The Agent stopped"));
    }

    for (const stop of this.#stops.toReversed()) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- Modules stop one at a time in reverse creation order.
        await stop();
      } catch (error) {
        this.#options.log.error("A module failed to stop", {
          error: errorMessage(error),
        });
      }
    }

    this.#db.close();
  };

  readonly #mountModules = async (): Promise<void> => {
    const ctx: AgentModuleContext = {
      agentDir: this.#options.agentDir,
      agentName: this.name,
      clock: this.#options.clock,
      db: this.#db,
      events: this.#options.events,
      log: this.#options.log,
    };

    const host: AgentHost = {
      approvals: this.#gate,
      maintenance: this.maintenance,
      triggers: this.triggers,
    };

    for (const module of this.#options.modules ?? []) {
      // oxlint-disable-next-line no-await-in-loop -- Modules are created one at a time in configuration order.
      const mounted = await module.mount(ctx, host);

      this.#rpc.push(mounted.rpc);

      if (mounted.stop !== undefined) {
        this.#stops.push(mounted.stop);
      }

      this.#pendingStarts.push(mounted.start);
    }
  };

  readonly #startModules = async (): Promise<void> => {
    for (const start of this.#pendingStarts) {
      // oxlint-disable-next-line no-await-in-loop -- Modules start in creation order.
      await start?.();
    }
  };

  readonly #openPi = async (): Promise<PiAdapter> => {
    const pi = await openPiAdapter({
      harnessPath: path.join(this.#options.agentDir, HARNESS_FILE),
      hooks: {
        checkTool: this.#checkTool,
        executeTool: this.#executeTool,
        onFailed: (error) => {
          this.#options.log.error("The Harness failed", {
            error: error.message,
          });
          this.#options.onFailed(error);
        },
        flushPrompt: () => this.#options.memory?.compactionFlushPrompt(),
      },
      log: this.#options.log,
      models: this.#options.models,
      now: this.#options.clock.now,
      tools: this.#extensions.tools().map((tool) => ({
        description: tool.description,
        inputSchema: tool.inputSchema,
        name: tool.name,
      })),
    });

    this.#pi = pi;
    this.#stops.push(pi.close);

    return pi;
  };

  readonly #requirePi = (): PiAdapter => {
    if (this.#pi === undefined || this.#closed) {
      throw new SeamError(
        "agent_unavailable",
        `Agent ${this.name} is not running`
      );
    }

    return this.#pi;
  };

  readonly #instructions = async (): Promise<string | undefined> => {
    const snapshot =
      this.#options.memory === undefined
        ? undefined
        : await this.#options.memory.snapshot();

    const parts = [
      this.#options.config.instructions,
      this.#extensions.skillCatalogPrompt(),
      snapshot === undefined || snapshot.text === ""
        ? undefined
        : `<memory>\n${snapshot.text}\n</memory>`,
    ].filter(
      (part): part is string => part !== undefined && part.trim() !== ""
    );

    return parts.length === 0 ? undefined : parts.join("\n\n");
  };

  readonly #createConversation = async (
    model: ModelChoice = this.#options.config.model
  ): Promise<string> =>
    await this.#requirePi().createConversation({
      cwd: this.#workspaceDir,
      instructions: await this.#instructions(),
      model,
    });

  readonly #chatConversation = async (chat: ChatKey): Promise<string> => {
    const existing = this.#store.chatConversation(chat.bindingId, chat.chatId);

    if (existing !== undefined) {
      return existing;
    }

    const created = await this.#createConversation();

    this.#store.setChatConversation(chat.bindingId, chat.chatId, created);

    return created;
  };

  readonly #now = (): string =>
    new Date(this.#options.clock.now()).toISOString();

  readonly #startRun = async (spec: RunSpec): Promise<SentMessage> => {
    const pi = this.#requirePi();
    const runId = randomUUID();
    const messageId = randomUUID();
    const startedAt = this.#now();
    const model = await pi.modelOf(spec.conversationId);

    this.#store.insertRun({
      conversationId: spec.conversationId,
      delivery: spec.delivery,
      interactive: spec.interactive,
      model,
      origin: spec.origin,
      runId,
      startedAt,
    });

    if (spec.userMessage !== undefined) {
      this.#recordMessage(spec.chat, spec.conversationId, {
        at: startedAt,
        messageId,
        role: "user",
        runId,
        senderDisplayName: spec.userMessage.senderDisplayName,
        text: spec.userMessage.text,
      });
      await this.#archive(spec.origin, {
        at: Date.parse(startedAt),
        conversationId: spec.conversationId,
        role: "user",
        text: spec.userMessage.text,
      });
    }

    const run = this.#track(runId, spec);
    const stored = this.#store.getRun(runId);

    if (stored !== undefined) {
      this.#options.events.emit("run.started", {
        agent: this.name,
        run: stored.summary,
      });
    }

    void this.#drive(run, async () => {
      const submissionId = await pi.submit(
        spec.conversationId,
        spec.prompt,
        runId
      );

      this.#store.setSubmission(runId, submissionId);

      return submissionId;
    });

    return { conversationId: spec.conversationId, messageId, runId };
  };

  readonly #track = (
    runId: string,
    spec: Pick<RunSpec, "chat" | "conversationId" | "interactive" | "origin">
  ): ActiveRun => {
    const run: ActiveRun = {
      chat: spec.chat,
      controller: new AbortController(),
      conversationId: spec.conversationId,
      done: Promise.withResolvers<MaintenanceRunResult>(),
      interactive: spec.interactive,
      origin: spec.origin,
      runId,
    };

    this.#active.set(runId, run);

    return run;
  };

  readonly #queueOf = (conversationId: string): SerialQueue => {
    const existing = this.#conversationQueues.get(conversationId);

    if (existing !== undefined) {
      return existing;
    }

    const created = new SerialQueue();

    this.#conversationQueues.set(conversationId, created);

    return created;
  };

  /**
   * Drives one Run to its end: one Run per Conversation at a time, within the Agent's `maxConcurrentRuns`. `submit`
   * admits the input, or returns the stored submission of a Run from before a restart.
   */
  readonly #drive = async (
    run: ActiveRun,
    submit: () => Promise<string>
  ): Promise<void> => {
    let outcome: PiRunOutcome;

    try {
      outcome = await this.#queueOf(run.conversationId).run(async () => {
        const lease = await this.#runSlots.acquire(
          "runs",
          run.controller.signal
        );

        try {
          const pi = this.#requirePi();

          const stopText = await pi.watchText(run.conversationId, (delta) => {
            this.#options.events.emit("run.delta", {
              agent: this.name,
              delta,
              runId: run.runId,
            });
          });

          try {
            // A stop that came while the watch started finds no driving Run, so the Run must not submit after it.
            run.controller.signal.throwIfAborted();
            this.#runByConversation.set(run.conversationId, run.runId);

            return await pi.wait(await submit());
          } finally {
            stopText();
          }
        } finally {
          this.#runByConversation.delete(run.conversationId);
          lease.release();
        }
      });
    } catch (error) {
      outcome = run.controller.signal.aborted
        ? { status: "stopped", text: "" }
        : {
            error: errorMessage(error),
            status: "failed",
            text: "",
          };
    }

    if (this.#closed) {
      // The Run stays active in storage and continues at the next open.
      this.#active.delete(run.runId);

      return;
    }

    await this.#finish(run, outcome);
  };

  /** Stores the end of a Run and resolves `run.done`. Never rejects: it logs a storage failure instead. */
  readonly #finish = async (
    run: ActiveRun,
    outcome: PiRunOutcome
  ): Promise<void> => {
    try {
      await this.#storeOutcome(run, outcome);
    } catch (error) {
      this.#options.log.error("The end of a Run could not be stored", {
        error: errorMessage(error),
        runId: run.runId,
      });
    } finally {
      this.#active.delete(run.runId);
      run.done.resolve({
        status: outcome.status,
        text: outcome.text,
        error: outcome.error,
      });
    }
  };

  readonly #storeOutcome = async (
    run: ActiveRun,
    outcome: PiRunOutcome
  ): Promise<void> => {
    const stored = this.#store.getRun(run.runId);
    const at = this.#now();

    try {
      if (outcome.text !== "") {
        await this.#recordReply(
          run,
          stored?.delivery ?? null,
          outcome.text,
          at
        );
        await this.#deliverReply(run, stored?.delivery ?? null, outcome.text);
      }
    } catch (error) {
      this.#options.log.error("A Run reply could not be delivered", {
        error: errorMessage(error),
        runId: run.runId,
      });
    }

    const ended = this.#store.endRun(run.runId, {
      endedAt: at,
      error: outcome.error,
      status: outcome.status,
      usage: outcome.usage,
    });

    this.#active.delete(run.runId);

    const summary = this.#store.getRun(run.runId)?.summary;

    if (ended && summary !== undefined) {
      this.#options.events.emit("run.finished", {
        agent: this.name,
        run: summary,
      });
    }
  };

  /**
   * Stores the final reply. A reply for the CLI Chat, also from a Trigger that targets it, goes into the Chat's current
   * Conversation and out as a `chat.message` event.
   */
  readonly #recordReply = async (
    run: ActiveRun,
    delivery: RunDelivery | null,
    text: string,
    at: string
  ): Promise<void> => {
    const message: ChatMessage = {
      at,
      messageId: randomUUID(),
      role: "assistant",
      runId: run.runId,
      source: run.origin.kind === "trigger" ? "trigger" : "reply",
      text,
    };

    const triggerToCli =
      run.chat === null && delivery !== null && isCliChat(delivery);

    if (
      triggerToCli &&
      (await this.#options.isDeliverySuppressed?.(run.runId)) !== true
    ) {
      const conversationId = await this.#chatConversation(CLI_CHAT);

      this.#recordMessage(CLI_CHAT, conversationId, message);
      await this.#archive(run.origin, {
        at: Date.parse(at),
        conversationId,
        role: "assistant",
        text,
      });

      return;
    }

    this.#recordMessage(
      isCliChat(run.chat) ? run.chat : null,
      run.conversationId,
      message
    );
    await this.#archive(run.origin, {
      at: Date.parse(at),
      conversationId: run.conversationId,
      role: "assistant",
      text,
    });
  };

  /**
   * Adds a user or assistant message to the Memory archive. Maintenance Runs stay out of it, so that consolidation
   * output does not feed the next consolidation. A failure only logs: the message is stored in `agent.sqlite` already.
   */
  readonly #archive = async (
    origin: RunOrigin,
    message: ArchivedMessage
  ): Promise<void> => {
    if (this.#options.memory === undefined || origin.kind === "maintenance") {
      return;
    }

    try {
      await this.#options.memory.archive(message);
    } catch (error) {
      this.#options.log.warn("A message could not be archived", {
        conversationId: message.conversationId,
        error: errorMessage(error),
      });
    }
  };

  readonly #deliverReply = async (
    run: ActiveRun,
    delivery: RunDelivery | null,
    text: string
  ): Promise<void> => {
    if (delivery === null || isCliChat(delivery)) {
      return;
    }

    if (
      run.origin.kind === "trigger" &&
      (await this.#options.isDeliverySuppressed?.(run.runId)) === true
    ) {
      return;
    }

    if (this.#options.outbox === undefined) {
      this.#options.log.warn("No outbox: a reply was dropped", {
        bindingId: delivery.bindingId,
        runId: run.runId,
      });

      return;
    }

    await this.#options.outbox.enqueue({
      bindingId: delivery.bindingId,
      chatId: delivery.chatId,
      delivery: {
        kind: "message",
        runId: run.runId,
        source: delivery.source,
        text,
      },
      sourceConversationId: delivery.sourceConversationId,
    });
  };

  readonly #recordMessage = (
    chat: ChatKey | null,
    conversationId: string,
    message: ChatMessage
  ): void => {
    this.#store.insertMessage({ chat, conversationId, message });

    if (
      message.runId !== undefined &&
      (message.role === "user" || message.source !== "command")
    ) {
      const item: RunTimelineItem =
        message.role === "user"
          ? {
              at: message.at,
              kind: "user_message",
              senderDisplayName: message.senderDisplayName,
              text: message.text,
            }
          : { at: message.at, kind: "assistant_text", text: message.text };

      this.#store.putTimelineItem(
        message.runId,
        `message:${message.messageId}`,
        item
      );
    }

    if (isCliChat(chat)) {
      this.#options.events.emit("chat.message", { agent: this.name, message });
    }
  };

  /** Sends a command reply to the Chat: an event for the CLI Chat, or an outbox delivery for any other Chat. */
  readonly #reply = async (chat: ChatKey, text: string): Promise<void> => {
    const conversationId = await this.#chatConversation(chat);

    if (isCliChat(chat)) {
      this.#recordMessage(chat, conversationId, {
        at: this.#now(),
        messageId: randomUUID(),
        role: "assistant",
        source: "command",
        text,
      });

      return;
    }

    await this.#options.outbox?.enqueue({
      bindingId: chat.bindingId,
      chatId: chat.chatId,
      delivery: { kind: "message", source: "command", text },
    });
  };

  readonly #resumeRuns = (): void => {
    for (const stored of this.#store.activeRuns()) {
      const { summary, submissionId } = stored;

      const chat: ChatKey | null =
        summary.origin.kind === "chat"
          ? {
              bindingId: summary.origin.bindingId,
              chatId: summary.origin.chatId,
            }
          : null;

      const run = this.#track(summary.runId, {
        chat,
        conversationId: summary.conversationId,
        interactive: stored.interactive,
        origin: summary.origin,
      });

      if (submissionId === undefined) {
        void this.#finish(run, {
          error: "The daemon stopped before the Run started",
          status: "failed",
          text: "",
        });
      } else {
        void this.#drive(run, async () => {
          await Promise.resolve();

          return submissionId;
        });
      }
    }
  };

  readonly #runOf = (conversationId: string): RunLookup => {
    const runId = this.#runByConversation.get(conversationId) ?? "";

    return { run: this.#active.get(runId), runId };
  };

  readonly #checkTool = async (call: PiToolCall): Promise<PiGateVerdict> => {
    const { run, runId } = this.#runOf(call.conversationId);

    const verdict = await this.#gate.check({
      callKey: call.callKey,
      chat: run?.chat ?? null,
      conversationId: call.conversationId,
      input: call.input,
      interactive: run?.interactive ?? false,
      runId: runId === "" ? `unknown:${call.conversationId}` : runId,
      toolName: call.toolName,
    });

    if (runId !== "") {
      this.#store.setActiveStatus(
        runId,
        verdict.kind === "wait" ? "waiting_approval" : "running"
      );
    }

    if (verdict.kind === "wait") {
      if (
        runId !== "" &&
        this.#store.timelineItem(`approval:${verdict.approvalId}`) === undefined
      ) {
        this.#store.putTimelineItem(runId, `approval:${verdict.approvalId}`, {
          approvalId: verdict.approvalId,
          at: this.#now(),
          kind: "approval",
          toolName: call.toolName,
        });
      }

      return {
        expiresAt: verdict.expiresAt,
        kind: "wait",
        signalKey: verdict.signalKey,
      };
    }

    return verdict.kind === "allow"
      ? { kind: "allow" }
      : { kind: "deny", message: verdict.message };
  };

  readonly #executeTool = async (
    call: PiToolCall,
    signal: AbortSignal
  ): Promise<ToolResult> => {
    const { run, runId } = this.#runOf(call.conversationId);

    const inputPreview = preview(
      this.#options.secrets.redact(JSON.stringify(call.input)),
      TOOL_INPUT_PREVIEW_MAX_LENGTH
    );

    const startedAt = this.#now();
    const key = `tool:${call.callKey}`;

    if (runId !== "") {
      this.#options.events.emit("run.toolStarted", {
        agent: this.name,
        inputPreview,
        runId,
        toolCallId: call.toolCallId,
        toolName: call.toolName,
      });
      this.#store.putTimelineItem(runId, key, {
        endedAt: null,
        inputPreview,
        kind: "tool_call",
        startedAt,
        toolCallId: call.toolCallId,
        toolName: call.toolName,
      });
    }

    const signals =
      run === undefined ? [signal] : [signal, run.controller.signal];

    const result = await this.#extensions.executeTool(
      call.toolName,
      call.input,
      {
        agentName: this.name,
        chat: run?.chat ?? null,
        conversationId: call.conversationId,
        log: this.#options.log,
        runId,
        signal: AbortSignal.any(signals),
        toolCallId: call.toolCallId,
        workspaceDir: this.#workspaceDir,
      }
    );

    if (runId !== "") {
      const outputPreview = preview(
        this.#options.secrets.redact(resultText(result)),
        TOOL_OUTPUT_PREVIEW_MAX_LENGTH
      );

      const isError = result.isError === true;

      this.#store.putTimelineItem(runId, key, {
        endedAt: this.#now(),
        inputPreview,
        isError,
        kind: "tool_call",
        outputPreview,
        startedAt,
        toolCallId: call.toolCallId,
        toolName: call.toolName,
      });
      this.#options.events.emit("run.toolFinished", {
        agent: this.name,
        isError,
        outputPreview,
        runId,
        toolCallId: call.toolCallId,
        toolName: call.toolName,
      });
    }

    return result;
  };

  readonly #activeRunOf = (chat: ChatKey): ActiveRun | undefined =>
    [...this.#active.values()].find(
      (run) =>
        run.chat?.bindingId === chat.bindingId &&
        run.chat.chatId === chat.chatId
    );

  readonly #newConversation = async (chat: ChatKey): Promise<boolean> => {
    const previous = this.#store.chatConversation(chat.bindingId, chat.chatId);
    const created = await this.#createConversation();

    this.#store.setChatConversation(chat.bindingId, chat.chatId, created);

    if (previous !== undefined) {
      await this.#gate.clearConversationGrants(previous);
    }

    await this.#reply(chat, "Started a new Conversation.");

    return true;
  };

  readonly #changeModel = async (
    chat: ChatKey,
    args: string | undefined
  ): Promise<boolean> => {
    if (args === undefined) {
      return false;
    }

    const model = parseModelArgument(args, this.#options.config.model);

    if (this.#options.models.getModel(model.provider, model.id) === undefined) {
      await this.#reply(chat, `Unknown model: ${model.provider}/${model.id}`);

      return false;
    }

    const conversationId = await this.#chatConversation(chat);

    await this.#requirePi().setModel(conversationId, model);
    await this.#reply(
      chat,
      `This Conversation now uses ${model.provider}/${model.id}.`
    );

    return true;
  };

  readonly #compact = async (chat: ChatKey): Promise<boolean> => {
    const pi = this.#requirePi();
    const conversationId = await this.#chatConversation(chat);
    const flushPrompt = this.#options.memory?.compactionFlushPrompt();

    if (flushPrompt !== undefined) {
      // The silent flush turn lets the model save facts to Memory before the summary replaces old messages (ADR 0009).
      const submissionId = await pi.submit(
        conversationId,
        flushPrompt,
        `flush:${randomUUID()}`
      );

      await pi.wait(submissionId);
    }

    await pi.compact(conversationId);
    await pi.setInstructions(conversationId, await this.#instructions());
    await this.#reply(chat, "Compacted the Conversation.");

    return true;
  };

  readonly #stopChat = async (chat: ChatKey): Promise<boolean> => {
    const run = this.#activeRunOf(chat);

    return run === undefined ? false : await this.stopRun(run.runId);
  };

  readonly #goal = async (
    chat: ChatKey,
    args: string | undefined
  ): Promise<boolean> => {
    if (args === undefined) {
      return false;
    }

    const conversationId = await this.#chatConversation(chat);

    await this.#startRun({
      chat,
      conversationId,
      delivery: deliveryFor(chat, "reply"),
      interactive: true,
      origin: { bindingId: chat.bindingId, chatId: chat.chatId, kind: "chat" },
      prompt: `Goal: ${args}\n\nWork on this goal autonomously with your Tools until it is done or blocked. Then report the result.`,
      userMessage: { senderDisplayName: undefined, text: `/goal ${args}` },
    });

    return true;
  };

  readonly #reportStatus = async (chat: ChatKey): Promise<boolean> => {
    const conversationId = await this.#chatConversation(chat);

    const model =
      (await this.#requirePi().modelOf(conversationId)) ?? "unknown";

    const run = this.#activeRunOf(chat);
    const status = this.status();

    const lines = [
      `Agent: ${this.name}`,
      `Conversation: ${conversationId}`,
      `Model: ${model}`,
      `Active Run: ${run?.runId ?? "none"}`,
      `Active Runs of the Agent: ${status.activeRuns}`,
      `Failed extensions: ${[...status.plugins, ...status.mcpServers].filter((item) => item.state === "failed").length}`,
    ];

    await this.#reply(chat, lines.join("\n"));

    return true;
  };

  readonly #startMaintenance: MaintenanceRunner["start"] = async (request) => {
    const conversationId = await this.#createConversation(request.model);

    const { runId } = await this.#startRun({
      chat: null,
      conversationId,
      delivery: null,
      interactive: false,
      origin: { job: request.job, kind: "maintenance" },
      prompt: request.prompt,
      userMessage: undefined,
    });

    return { runId };
  };

  readonly #waitRun: MaintenanceRunner["wait"] = async (runId) => {
    const active = this.#active.get(runId);

    if (active !== undefined && active.origin.kind === "maintenance") {
      return await active.done.promise;
    }

    const stored = this.#store.getRun(runId);

    if (stored === undefined || stored.summary.origin.kind !== "maintenance") {
      throw new SeamError("not_found", `Unknown maintenance Run: ${runId}`);
    }

    await Promise.resolve();
    const { status, error } = stored.summary;

    const ended =
      status === "completed" || status === "failed" || status === "stopped"
        ? status
        : "failed";

    return {
      status: ended,
      text: this.#store.runReply(runId),
      error,
    };
  };

  readonly #startTrigger: TriggerRunner["start"] = async (firing) => {
    const { trigger } = firing;

    let conversationId =
      trigger.conversationMode === "shared"
        ? this.#store.triggerConversation(trigger.id)
        : undefined;

    if (conversationId === undefined) {
      conversationId = await this.#createConversation();

      if (trigger.conversationMode === "shared") {
        this.#store.setTriggerConversation(trigger.id, conversationId);
      }
    }

    const { runId } = await this.#startRun({
      chat: null,
      conversationId,
      delivery: {
        bindingId: firing.target.bindingId,
        chatId: firing.target.chatId,
        source: "trigger",
        sourceConversationId: conversationId,
      },
      interactive: false,
      origin: { kind: "trigger", triggerId: trigger.id },
      prompt: firing.prompt,
      userMessage: undefined,
    });

    return { runId };
  };

  readonly #isTriggerActive = (triggerId: string): boolean =>
    [...this.#active.values()].some(
      (run) =>
        run.origin.kind === "trigger" && run.origin.triggerId === triggerId
    );
}
