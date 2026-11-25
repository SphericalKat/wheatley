// The only module of Wheatley that imports @earendil-works/pi-durable (ADR 0003). Everything outside it sees
// Wheatley's own types: string IDs, `ToolResult`, and `PiRunOutcome`.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord/context";
import type { Message, Models } from "@earendil-works/pi-ai";
import {
  CompactionTask,
  createRegistry,
  defineExtension,
  defineSignal,
  defineTool,
  Harness,
  hook,
  LiveDoc,
  ToolTask,
} from "@earendil-works/pi-durable";
import type {
  AgentChange,
  ConversationId,
  EntryId,
  EntryRecord,
  HookApi,
  LiveState,
  SettledSubmissionRecord,
  SubmissionId,
  TaskId,
  ToolRegistration,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { bool, obj } from "@earendil-works/pi-schema";
import { isJsonValue } from "@wheatley-ai/protocol";
import type { JsonValue, ModelChoice, RunUsage } from "@wheatley-ai/protocol";
import type { JsonSchema, Logger, ToolResult } from "@wheatley-ai/sdk";

import type { ParkedCall } from "../../contracts/approval-gate.js";
import { errorMessage } from "../error-message.js";

const context: Context = BACKGROUND_CONTEXT;

/** The longest run of entries that `wait` reads to sum a Run's usage. */
const RUN_ENTRY_PAGE = 500;

/** The memo of a compaction task that holds the ID of its flush fork, so a rerun after a crash reuses the fork. */
const FLUSH_FORK_MEMO = "wheatley.flush.fork";

/** The transcript entry of text that Wheatley adds to a Conversation's context without a Run. */
const CONTEXT_ENTRY_KIND = "wheatley.context";

/** Wakes a Tool call that waits for an Approval. The value carries nothing: the gate reads the decision itself. */
const ApprovalWake = defineSignal({
  name: "wheatley.approval.wake",
  schema: obj({ decided: bool() }),
  version: 1,
});

/** Holds the Harness once `Harness.open` resolves. */
interface HarnessHolder {
  harness: Awaited<ReturnType<typeof Harness.open>> | undefined;
}

/** One Tool that the Agent offers to the model, by its canonical Wheatley name. */
export interface PiToolSpec {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
}

/** One Tool call as the adapter reports it to the Agent. */
export interface PiToolCall {
  /** The pi-durable Tool task ID. Stable across parks, wakes, and daemon restarts. */
  readonly callKey: string;
  readonly conversationId: string;
  /** The model's call ID. */
  readonly toolCallId: string;
  /** The canonical Wheatley Tool name. */
  readonly toolName: string;
  readonly input: JsonValue;
}

/** What the Agent decides about a Tool call before it runs. */
export type PiGateVerdict =
  | { readonly kind: "allow" }
  | { readonly kind: "deny"; readonly message: string }
  | {
      readonly kind: "wait";
      readonly signalKey: string;
      readonly expiresAt: number | null;
    };

/** The Agent callbacks of the adapter. */
export interface PiAdapterHooks {
  /** Decides a call. The adapter calls it again after every wake of a parked call. */
  readonly checkTool: (call: PiToolCall) => Promise<PiGateVerdict>;
  /** Runs an allowed call. Never rejects: failures are error results. */
  readonly executeTool: (
    call: PiToolCall,
    signal: AbortSignal
  ) => Promise<ToolResult>;
  /** The Harness closed itself after a storage error (`SessionFailed`). The adapter is unusable afterward. */
  readonly onFailed: (error: Error) => void;
  /**
   * The prompt of the silent Memory flush turn before an automatic compaction, or `undefined` to skip it (ADR 0009).
   * A manual compaction (`compact`) never asks: its caller runs the flush turn first.
   */
  readonly flushPrompt: () => string | undefined;
}

/** Options of `openPiAdapter`. */
export interface PiAdapterOptions {
  /** The path of `harness.sqlite`. */
  readonly harnessPath: string;
  readonly models: Models;
  readonly tools: readonly PiToolSpec[];
  readonly hooks: PiAdapterHooks;
  readonly log: Logger;
  /** The Harness clock. Every process that opens the file must use the same clock. */
  readonly now?: () => number;
}

/** Settings of a new Conversation. */
export interface PiConversationOptions {
  readonly model: ModelChoice;
  readonly instructions: string | undefined;
  /** The working directory of the Conversation's Tools. */
  readonly cwd: string;
}

/** How a Run ended. */
export interface PiRunOutcome {
  readonly status: "completed" | "failed" | "stopped";
  /** The final assistant text, or an empty string. */
  readonly text: string;
  readonly error?: string;
  readonly usage?: RunUsage;
}

/** The pi-durable runtime of one Agent over its own `harness.sqlite` (ADR 0001). */
export interface PiAdapter {
  /** Creates a Conversation and resolves with its ID. */
  readonly createConversation: (
    options: PiConversationOptions
  ) => Promise<string>;
  /** Changes the model of one Conversation from its next model request. */
  readonly setModel: (
    conversationId: string,
    model: ModelChoice
  ) => Promise<void>;
  /** Replaces the instructions of one Conversation, for example a refreshed Memory snapshot after `/compact`. */
  readonly setInstructions: (
    conversationId: string,
    instructions: string | undefined
  ) => Promise<void>;
  /** The `provider/model` of a Conversation, or `undefined` for an unknown Conversation. */
  readonly modelOf: (conversationId: string) => Promise<string | undefined>;
  /**
   * Durably admits user input and resolves with the submission ID. `requestId` deduplicates: a second call with the
   * same ID resolves with the first submission. Input to a busy Conversation queues behind the current Run.
   */
  readonly submit: (
    conversationId: string,
    text: string,
    requestId: string
  ) => Promise<string>;
  /**
   * Adds `text` to the Conversation's model context without a Run. The model sees it as a user message from the next
   * model request. A busy Conversation places it at the next boundary.
   * `requestId` deduplicates as for `submit`.
   */
  readonly addContext: (
    conversationId: string,
    text: string,
    requestId: string
  ) => Promise<void>;
  /** Resolves when a submission settles, also for a submission from before a restart. */
  readonly wait: (submissionId: string) => Promise<PiRunOutcome>;
  /** Stops the Conversation's work and resolves once it is idle. Queued inputs end as `stopped`. */
  readonly stop: (conversationId: string) => Promise<void>;
  /** Compacts a Conversation now and resolves when the summary is stored or the compaction ends without one. */
  readonly compact: (conversationId: string) => Promise<void>;
  /**
   * Calls `onText` with each new piece of the assistant text that the Conversation streams, until the returned function
   * runs. pi-durable commits partial text at most every 100 ms, so one piece can hold many tokens. A new model response
   * starts again from its first character. `onText` runs outside the Harness's commit and must not throw.
   */
  readonly watchText: (
    conversationId: string,
    onText: (text: string) => void
  ) => Promise<() => void>;
  /** Wakes parked Tool calls so that they ask the gate again. Calls that ended meanwhile are skipped. */
  readonly wake: (calls: readonly ParkedCall[]) => Promise<void>;
  /** Closes the Harness and its storage. */
  readonly close: () => Promise<void>;
}

const isConversationId = (value: number): value is ConversationId =>
  Number.isSafeInteger(value) && value >= 0;

const isTaskId = (value: number): value is TaskId =>
  Number.isSafeInteger(value) && value >= 0;

const isSubmissionId = (value: number): value is SubmissionId =>
  Number.isSafeInteger(value) && value >= 0;

const conversationIdOf = (id: string): ConversationId => {
  const value = Number(id);

  if (!isConversationId(value)) {
    throw new Error(`Invalid Conversation ID: ${id}`);
  }

  return value;
};

const PROVIDER_SAFE = /[^A-Za-z0-9_-]/gu;
const MAX_PROVIDER_TOOL_NAME = 64;

/**
 * Maps canonical Tool names, such as `notes:add` or `mcp:github:create_issue`, to names that model providers accept
 * (`^[A-Za-z0-9_-]{1,64}$`), and back. Built-in names stay the same.
 */
const providerToolNames = (
  names: readonly string[]
): ReadonlyMap<string, string> => {
  const byProviderName = new Map<string, string>();

  for (const name of names) {
    const base = name
      .replaceAll(":", "__")
      .replaceAll(PROVIDER_SAFE, "_")
      .slice(0, MAX_PROVIDER_TOOL_NAME);

    let candidate = base;
    let suffix = 2;

    while (byProviderName.has(candidate)) {
      const tail = `_${suffix}`;

      candidate = `${base.slice(0, MAX_PROVIDER_TOOL_NAME - tail.length)}${tail}`;
      suffix += 1;
    }

    byProviderName.set(candidate, name);
  }

  return byProviderName;
};

const toolOutput = (result: ToolResult) =>
  result.content.map((block) =>
    block.type === "text"
      ? { text: block.text, type: "text" as const }
      : { data: block.data, mimeType: block.mimeType, type: "image" as const }
  );

const assistantText = (message: Message | undefined): string | undefined =>
  message?.role === "assistant"
    ? message.content
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("")
    : undefined;

const sumUsage = (entries: readonly EntryRecord[]): RunUsage => {
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;

  for (const entry of entries) {
    for (const message of entry.model ?? []) {
      if (message.role === "assistant") {
        inputTokens +=
          message.usage.input +
          message.usage.cacheRead +
          message.usage.cacheWrite;
        outputTokens += message.usage.output;
        costUsd += message.usage.cost.total;
      }
    }
  }

  return { costUsd, inputTokens, outputTokens };
};

/** The text of the partial response in `pi.live`, or `undefined` while no response streams. */
const partialText = (live: Readonly<LiveState>): string | undefined => {
  const message = live.generation?.message;

  if (message === undefined) {
    return undefined;
  }

  return message.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("");
};

const agentChange = (options: PiConversationOptions): AgentChange => ({
  cwd: options.cwd,
  instructions: options.instructions ?? null,
  model: { modelId: options.model.id, provider: options.model.provider },
  thinkingLevel: options.model.thinking ?? null,
});

/**
 * Opens the Harness of one Agent over `harness.sqlite` and starts its scheduler, so work that an earlier process left
 * unfinished continues.
 *
 * Every Tool call passes `hooks.checkTool` from a `beforeTool` hook before it runs. A `wait` verdict parks the call in a
 * durable signal sleep on the verdict's `signalKey`; `wake` ends the sleep, and the hook asks again.
 */
export const openPiAdapter = async (
  options: PiAdapterOptions
): Promise<PiAdapter> => {
  const { hooks, log } = options;
  const clock = options.now ?? Date.now;
  const toolNames = providerToolNames(options.tools.map((tool) => tool.name));
  const specs = new Map(options.tools.map((tool) => [tool.name, tool]));

  const canonical = (providerName: string): string =>
    toolNames.get(providerName) ?? providerName;

  const tools: ToolRegistration[] = [...toolNames.entries()].flatMap(
    ([providerName, name]) => {
      const spec = specs.get(name);

      return spec === undefined
        ? []
        : [
            defineTool({
              description: spec.description,
              execute: async (args, api, callContext) => {
                const input = isJsonValue(args) ? args : null;

                const result = await hooks.executeTool(
                  {
                    callKey: String(api.taskId),
                    conversationId: String(api.conversationId),
                    input,
                    toolCallId: api.callId,
                    toolName: name,
                  },
                  callContext.abortSignal ?? new AbortController().signal
                );

                return {
                  isError: result.isError === true,
                  output: toolOutput(result),
                };
              },
              name: providerName,
              parameters: spec.inputSchema,
            }),
          ];
    }
  );

  // The compaction hook runs after `Harness.open`, so it reaches the Harness through this holder.
  const opened: HarnessHolder = { harness: undefined };

  /**
   * Runs the flush prompt as one turn in a fork of the compacting Conversation at `at`, the newest entry that the
   * summary replaces. The fork sees what the summary replaces, and has the same Tools, so the model can save facts to
   * Memory. The fork never compacts by itself, and its answer goes nowhere.
   */
  const flush = async (
    api: HookApi,
    at: EntryId,
    prompt: string,
    hookContext: Context
  ): Promise<void> => {
    const { harness } = opened;

    if (harness === undefined) {
      return;
    }

    let forkId = await api.memo<number>(FLUSH_FORK_MEMO, hookContext);

    if (forkId === undefined) {
      const parent = await harness.conversation(
        api.conversationId,
        hookContext
      );

      if (parent === undefined) {
        return;
      }

      const fork = await parent.fork(
        at,
        {
          agent: { compaction: { enabled: false } },
          ownership: { kind: "ownerless" },
        },
        hookContext
      );

      forkId = await api.memo<number>(FLUSH_FORK_MEMO, fork.id, hookContext);
    }

    const handle = isConversationId(forkId)
      ? await harness.conversation(forkId, hookContext)
      : undefined;

    if (handle === undefined) {
      return;
    }

    const submission = await handle.submit(
      { content: prompt, requestId: `flush:${api.taskId}`, type: "input" },
      hookContext
    );

    await submission.wait(hookContext);
  };

  const extension = defineExtension({
    hooks: [
      hook(CompactionTask, {
        beforeCompact: async (compaction, api, hookContext) => {
          const last = compaction.entries.at(-1);

          const prompt =
            compaction.reason === "manual" ? undefined : hooks.flushPrompt();

          if (prompt !== undefined && last !== undefined) {
            try {
              await flush(api, last.id, prompt, hookContext);
            } catch (error) {
              // A failed flush must not block the compaction: without it, the next model request can overflow.
              log.warn("The Memory flush before a compaction failed", {
                conversationId: String(api.conversationId),
                error: errorMessage(error),
              });
            }
          }
        },
      }),
      hook(ToolTask, {
        beforeTool: async (call, api) => {
          const verdict = await hooks.checkTool({
            callKey: String(api.taskId),
            conversationId: String(api.conversationId),
            input: isJsonValue(call.arguments) ? call.arguments : null,
            toolCallId: call.id,
            toolName: canonical(call.name),
          });

          if (verdict.kind === "allow") {
            return {};
          }

          if (verdict.kind === "deny") {
            return { block: verdict.message };
          }

          return {
            sleep: {
              signals: [ApprovalWake.key(verdict.signalKey)],
              until: verdict.expiresAt ?? undefined,
            },
          };
        },
      }),
    ],
    name: "wheatley",
    tools,
  });

  const registry = createRegistry();

  registry.install(extension);

  const storage = await openNodeSqliteStorage(options.harnessPath);

  const harness = await Harness.open(
    storage,
    {
      models: options.models,
      now: options.now,
      onReport: (report) => {
        log.warn("pi-durable report", {
          kind: report.kind,
          message: errorMessage(report.error),
        });
      },
      registry,
    },
    context
  );

  const watchClosed = async (): Promise<void> => {
    const end = await harness.closed;

    if (end.kind === "failed") {
      hooks.onFailed(
        end.error instanceof Error ? end.error : new Error(String(end.error))
      );
    }
  };

  opened.harness = harness;
  void watchClosed();
  harness.resume();

  const conversation = async (id: string) => {
    const found = await harness.conversation(conversationIdOf(id), context);

    if (found === undefined) {
      throw new Error(`Unknown Conversation: ${id}`);
    }

    return found;
  };

  const outcomeOf = async (
    settled: SettledSubmissionRecord
  ): Promise<PiRunOutcome> => {
    if (settled.type !== "input") {
      return { status: "completed", text: "" };
    }

    if (settled.status === "unanswered") {
      const detail =
        settled.detail === undefined
          ? ""
          : `: ${JSON.stringify(settled.detail)}`;

      return settled.reason === "aborted"
        ? { status: "stopped", text: "" }
        : { error: `${settled.reason}${detail}`, status: "failed", text: "" };
    }

    if (settled.answer === undefined) {
      return { status: "completed", text: "" };
    }

    const handle = await conversation(String(settled.conversationId));

    const page = await handle.entries(
      {
        maxEntryId: settled.answer,
        minEntryId: settled.entry,
        order: "ascending",
      },
      RUN_ENTRY_PAGE,
      undefined,
      context
    );

    const answer = page.items.find((entry) => entry.id === settled.answer);

    return {
      status: "completed",
      text: assistantText(answer?.model?.[0]) ?? "",
      usage: sumUsage(page.items),
    };
  };

  return {
    addContext: async (conversationId, text, requestId) => {
      const handle = await conversation(conversationId);

      await handle.submit(
        {
          entry: {
            data: { text },
            kind: CONTEXT_ENTRY_KIND,
            model: [{ content: text, role: "user", timestamp: clock() }],
          },
          requestId,
          type: "write",
        },
        context
      );
    },
    close: async () => {
      await harness.close(context);
    },
    compact: async (conversationId) => {
      const handle = await conversation(conversationId);
      const taskId = await handle.compact(undefined, context);

      await harness.waitForTask(taskId, context);
    },
    createConversation: async (conversationOptions) => {
      const created = await harness.createConversation(
        {
          agent: agentChange(conversationOptions),
          ownership: { kind: "ownerless" },
        },
        context
      );

      return String(created.id);
    },
    modelOf: async (conversationId) => {
      const found = await harness.conversation(
        conversationIdOf(conversationId),
        context
      );

      const agent =
        found === undefined ? undefined : await found.agent(context);

      const model = agent?.model;

      return model === undefined
        ? undefined
        : `${model.provider}/${model.modelId}`;
    },
    setInstructions: async (conversationId, instructions) => {
      const handle = await conversation(conversationId);

      await handle.configure({ instructions: instructions ?? null }, context);
    },
    setModel: async (conversationId, model) => {
      const handle = await conversation(conversationId);

      await handle.configure(
        {
          model: { modelId: model.id, provider: model.provider },
          thinkingLevel: model.thinking ?? null,
        },
        context
      );
    },
    stop: async (conversationId) => {
      const handle = await conversation(conversationId);

      await handle.abort(context);
    },
    submit: async (conversationId, text, requestId) => {
      const handle = await conversation(conversationId);

      const submission = await handle.submit(
        { content: text, requestId, type: "input" },
        context
      );

      return String(submission.id);
    },
    wait: async (submissionId) => {
      const id = Number(submissionId);

      if (!isSubmissionId(id)) {
        throw new Error(`Invalid submission ID: ${submissionId}`);
      }

      const submission = await harness.submission(id, context);

      if (submission === undefined) {
        return {
          error: "The submission no longer exists",
          status: "failed",
          text: "",
        };
      }

      return await outcomeOf(await submission.wait(context));
    },
    watchText: async (conversationId, onText) => {
      let sent = "";

      const forward = (live: Readonly<LiveState>): void => {
        const text = partialText(live);

        if (text === undefined) {
          sent = "";

          return;
        }

        // A shorter or different text belongs to a new response.
        const start = text.startsWith(sent) ? sent.length : 0;
        const piece = text.slice(start);

        sent = text;

        if (piece !== "") {
          // The observer must not call back into the Harness or throw, so the listener runs after it returns.
          queueMicrotask(() => {
            onText(piece);
          });
        }
      };

      const observation = await harness.observeDoc(
        LiveDoc,
        conversationIdOf(conversationId),
        {
          advance: (call) => {
            if (call.kind === "value") {
              forward(call.value);
            }
          },
          end: () => {
            // The Harness closed; the Run ends with it.
          },
        },
        context
      );

      if (observation === undefined) {
        return () => {
          // The Conversation has no live document to watch.
        };
      }

      forward(observation.value);

      return () => {
        observation.detach();
      };
    },
    wake: async (calls) => {
      await Promise.all(
        calls.map(async (call) => {
          const taskId = Number(call.callKey);

          if (!isTaskId(taskId)) {
            return;
          }

          const result = await harness.signal(
            taskId,
            ApprovalWake,
            call.signalKey,
            { decided: true },
            context
          );

          if (result !== "delivered" && result !== "duplicate") {
            log.debug("An Approval wake found no parked call", {
              callKey: call.callKey,
              result,
            });
          }
        })
      );
    },
  };
};
