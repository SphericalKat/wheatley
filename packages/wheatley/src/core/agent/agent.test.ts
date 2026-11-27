import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import type { FauxResponseFactory, Message } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InMemoryApprovalGate } from "../../contracts/approval-gate.fake.js";
import { InMemoryConfigStore } from "../../contracts/config-store.fake.js";
import { InMemoryDeliveryOutbox } from "../../contracts/delivery-outbox.fake.js";
import type { OutboxItem } from "../../contracts/delivery-outbox.js";
import { InMemoryMemoryStore } from "../../contracts/memory-store.fake.js";
import { systemClock } from "../../contracts/module.js";
import { InMemorySecretStore } from "../../contracts/secret-store.fake.js";
import {
  builtinCatalog,
  createFakeLlm,
  EventRecorder,
  FAKE_PROVIDER,
  ignore,
  silentLogger,
  temporaryDir,
} from "../test-support.js";
import type { FakeLlm } from "../test-support.js";
import { Agent, CLI_CHAT, WORKSPACE_DIR } from "./agent.js";
import type { AgentOptions } from "./agent.js";

let home: Awaited<ReturnType<typeof temporaryDir>>;
let llm: FakeLlm;
let events: EventRecorder;

/** The Agent's Memory hooks over a fake store, with an empty snapshot prompt. */
const agentMemory = (store: InMemoryMemoryStore): AgentOptions["memory"] => ({
  archive: async (message) => {
    await store.archive(message);
  },
  compactionFlushPrompt: () => store.compactionFlushPrompt(),
  snapshotPrompt: async () => {
    await Promise.resolve();

    return "";
  },
});

const openAgent = async (
  overrides: Partial<AgentOptions> = {}
): Promise<Agent> =>
  await Agent.open({
    agentDir: path.join(home.dir, "agents", "home"),
    clock: systemClock,
    config: {
      model: `${FAKE_PROVIDER}/${llm.modelId}`,
      permissionPolicy: [{ action: "allow", tool: "*" }],
    },
    events,
    extensions: builtinCatalog(),
    homeDir: home.dir,
    log: silentLogger,
    models: llm.models,
    name: "home",
    onFailed: ignore,
    onRestartRequested: ignore,
    secrets: new InMemorySecretStore(),
    ...overrides,
  });

const messageText = (message: Message): string => {
  const { content } = message;

  if (!Array.isArray(content)) {
    return content;
  }

  const texts: string[] = [];

  for (const block of content) {
    if (block.type === "text") {
      texts.push(block.text);
    }
  }

  return texts.join("");
};

/** Sends a CLI Chat message and waits until `finished` Runs ended. */
const sendAndFinish = async (
  agent: Agent,
  text: string,
  finished: number
): Promise<void> => {
  await agent.send(CLI_CHAT, { interactive: true, text });
  await vi.waitFor(() => {
    expect(events.of("run.finished")).toHaveLength(finished);
  });
};

/** The marker of the summary request that pi-durable sends to the model. */
const SUMMARY_REQUEST = "<conversation>";

const FLUSH_PROMPT = "Save durable facts to Memory now.";

/** Characters of one large Chat message: about 8,000 tokens for the fake LLM. */
const LARGE_MESSAGE_CHARS = 32_000;

/** A context window that makes pi-durable compact after three large messages. */
const SMALL_CONTEXT_WINDOW = 40_000;

beforeEach(async () => {
  home = await temporaryDir();
  llm = createFakeLlm();
  events = new EventRecorder();
});

afterEach(async () => {
  await home.remove();
});

describe("Agent", () => {
  it("answers a CLI Chat message after it runs read_file, write_file, and shell", async () => {
    const agent = await openAgent();

    try {
      await writeFile(
        path.join(home.dir, "agents", "home", WORKSPACE_DIR, "in.txt"),
        "hello"
      );
      llm.faux.setResponses([
        fauxAssistantMessage(
          [
            fauxToolCall("read_file", { path: "in.txt" }),
            fauxToolCall("write_file", { content: "copied", path: "out.txt" }),
            fauxToolCall("shell", { command: "echo shell-ran" }),
          ],
          { stopReason: "toolUse" }
        ),
        fauxAssistantMessage("All done"),
      ]);

      const sent = await agent.send(CLI_CHAT, {
        interactive: true,
        text: "Copy the file",
      });

      await vi.waitFor(() => {
        expect(events.of("run.finished")).toHaveLength(1);
      });

      const [finished] = events.of("run.finished");

      expect(finished?.run).toMatchObject({
        runId: sent.runId,
        status: "completed",
      });
      expect(
        events
          .of("chat.message")
          .map(({ message }) => [message.role, message.text])
      ).toStrictEqual([
        ["user", "Copy the file"],
        ["assistant", "All done"],
      ]);
      expect(
        events
          .of("run.toolFinished")
          .map(({ toolName, isError }) => [toolName, isError])
      ).toStrictEqual([
        ["read_file", false],
        ["write_file", false],
        ["shell", false],
      ]);
      await expect(
        readFile(
          path.join(home.dir, "agents", "home", WORKSPACE_DIR, "out.txt"),
          "utf-8"
        )
      ).resolves.toBe("copied");
    } finally {
      await agent.close();
    }
  });
  it("parks an ask Tool until the Approval is decided, then runs it", async () => {
    const configStore = new InMemoryConfigStore({
      agents: { home: { model: `${FAKE_PROVIDER}/${llm.modelId}` } },
      version: 1,
    });

    const outbox = new InMemoryDeliveryOutbox("home", {
      deliver: async () => {
        await Promise.resolve();
      },
      onDelivered: async () => {
        await Promise.resolve();
      },
    });

    let gate: InMemoryApprovalGate | undefined;

    const agent = await openAgent({
      approvals: (host) => {
        gate = new InMemoryApprovalGate(
          host.agentName,
          {
            ...host,
            config: configStore,
            outbox,
            secrets: new InMemorySecretStore(),
          },
          { clock: host.clock, events: host.events }
        );

        return gate;
      },
      config: { model: `${FAKE_PROVIDER}/${llm.modelId}` },
    });

    try {
      llm.faux.setResponses([
        fauxAssistantMessage(
          fauxToolCall("shell", { command: "echo approved > approved.txt" }),
          {
            stopReason: "toolUse",
          }
        ),
        fauxAssistantMessage("Ran it"),
      ]);

      const sent = await agent.send(CLI_CHAT, {
        interactive: true,
        text: "Run the command",
      });

      await vi.waitFor(() => {
        expect(events.of("approval.requested")).toHaveLength(1);
      });

      const [requested] = events.of("approval.requested");

      expect(requested?.approval).toMatchObject({
        runId: sent.runId,
        toolName: "shell",
      });
      expect(agent.getRun(sent.runId).run.status).toBe("waiting_approval");

      await expect(
        gate?.decide(
          requested?.approval.approvalId ?? "",
          { decision: "allow_once" },
          { kind: "operator" }
        )
      ).resolves.toBe(true);
      await vi.waitFor(() => {
        expect(events.of("run.finished")).toHaveLength(1);
      });

      expect(agent.getRun(sent.runId).run.status).toBe("completed");
      expect(
        agent.getRun(sent.runId).timeline.map((item) => item.kind)
      ).toStrictEqual([
        "user_message",
        "approval",
        "tool_call",
        "assistant_text",
      ]);
      await expect(
        readFile(
          path.join(home.dir, "agents", "home", WORKSPACE_DIR, "approved.txt"),
          "utf-8"
        )
      ).resolves.toBe("approved\n");
    } finally {
      await agent.close();
    }
  });

  it("denies an ask Tool without an Approval gate and lets the model continue", async () => {
    const agent = await openAgent({
      config: { model: `${FAKE_PROVIDER}/${llm.modelId}` },
    });

    try {
      llm.faux.setResponses([
        fauxAssistantMessage(
          fauxToolCall("shell", { command: "touch denied.txt" }),
          { stopReason: "toolUse" }
        ),
        (context) => {
          const result = context.messages.findLast(
            (message) => message.role === "toolResult"
          );

          return fauxAssistantMessage(
            result?.role === "toolResult" && result.isError
              ? "It was denied"
              : "It ran"
          );
        },
      ]);

      await agent.send(CLI_CHAT, { interactive: true, text: "Touch a file" });
      await vi.waitFor(() => {
        expect(events.of("run.finished")).toHaveLength(1);
      });

      expect(events.of("chat.message").at(-1)?.message.text).toBe(
        "It was denied"
      );
      expect(events.of("run.toolStarted")).toHaveLength(0);
    } finally {
      await agent.close();
    }
  });

  it("stops an active Run for /stop", async () => {
    const agent = await openAgent();
    const release = Promise.withResolvers<undefined>();

    try {
      llm.faux.setResponses([
        async () => {
          await release.promise;

          return fauxAssistantMessage("too late");
        },
      ]);

      const sent = await agent.send(CLI_CHAT, {
        interactive: true,
        text: "Think for a while",
      });

      await expect(agent.command(CLI_CHAT, "stop", undefined)).resolves.toBe(
        true
      );
      expect(events.of("chat.message").at(-1)?.message.text).toBe(
        "Stopped the active Run."
      );
      release.resolve(undefined);
      await vi.waitFor(() => {
        expect(events.of("run.finished")).toHaveLength(1);
      });

      expect(agent.getRun(sent.runId).run.status).toBe("stopped");
      await expect(agent.command(CLI_CHAT, "stop", undefined)).resolves.toBe(
        false
      );
      expect(events.of("chat.message").at(-1)?.message.text).toBe(
        "No Run is active."
      );
    } finally {
      await agent.close();
    }
  });

  it("replies with the usage for /goal without an argument, and once for an unknown model", async () => {
    const agent = await openAgent();

    try {
      const replies = (): string[] =>
        events.of("chat.message").map((event) => event.message.text);

      await expect(agent.command(CLI_CHAT, "goal", undefined)).resolves.toBe(
        false
      );
      await expect(
        agent.command(CLI_CHAT, "model", "unknown-model")
      ).resolves.toBe(false);
      await expect(
        agent.command(CLI_CHAT, "model", `${FAKE_PROVIDER}/unknown-model`)
      ).resolves.toBe(false);

      expect(replies()).toStrictEqual([
        "Usage: /goal <objective>",
        `Unknown model: ${FAKE_PROVIDER}/unknown-model`,
        `Unknown model: ${FAKE_PROVIDER}/unknown-model`,
      ]);
      expect(events.of("run.started")).toHaveLength(0);
    } finally {
      await agent.close();
    }
  });

  it("lists the available models for /model without an argument and marks the current model", async () => {
    llm.models.setProvider(
      fauxProvider({
        models: [{ id: "zeta-2" }, { id: "zeta-1" }],
        provider: "zeta",
      }).provider
    );
    const agent = await openAgent();

    try {
      await expect(agent.command(CLI_CHAT, "model", undefined)).resolves.toBe(
        true
      );
      await expect(
        agent.command(CLI_CHAT, "model", "zeta/zeta-1")
      ).resolves.toBe(true);
      await expect(agent.command(CLI_CHAT, "model", undefined)).resolves.toBe(
        true
      );

      const replies = events
        .of("chat.message")
        .map((event) => event.message.text);

      expect(replies).toStrictEqual([
        [
          `Current model: ${FAKE_PROVIDER}/${llm.modelId}`,
          `**${FAKE_PROVIDER}**\n- ${llm.modelId} (current)`,
          "**zeta**\n- zeta-1\n- zeta-2",
          "Use /model <id> or /model <provider>/<id> to switch.",
        ].join("\n\n"),
        "This Conversation now uses zeta/zeta-1.",
        [
          "Current model: zeta/zeta-1",
          `**${FAKE_PROVIDER}**\n- ${llm.modelId}`,
          "**zeta**\n- zeta-1 (current)\n- zeta-2",
          "Use /model <id> or /model <provider>/<id> to switch.",
        ].join("\n\n"),
      ]);
    } finally {
      await agent.close();
    }
  });

  it("reports that no provider has credentials for /model without an argument", async () => {
    llm.models.setProvider({
      ...llm.faux.provider,
      auth: {
        apiKey: {
          name: "Faux",
          resolve: async () => {
            await Promise.resolve();
          },
        },
      },
    });
    const agent = await openAgent();

    try {
      await expect(agent.command(CLI_CHAT, "model", undefined)).resolves.toBe(
        true
      );

      expect(events.of("chat.message").at(-1)?.message.text).toBe(
        `Current model: ${FAKE_PROVIDER}/${llm.modelId}\n\nNo providers have credentials configured.`
      );
    } finally {
      await agent.close();
    }
  });

  it("attaches the model picker to the /model delivery of a non-CLI Chat", async () => {
    const enqueued: OutboxItem[] = [];

    const agent = await openAgent({
      outbox: {
        enqueue: async (item) => {
          await Promise.resolve();
          enqueued.push(item);

          return {
            attempts: 0,
            bindingId: item.bindingId,
            chatId: item.chatId,
            createdAt: 0,
            delivery: { ...item.delivery, chatId: item.chatId, messageId: "m" },
            deliveryId: "m",
            lastError: null,
            nextAttemptAt: null,
            permanent: false,
            sourceConversationId: undefined,
            status: "pending",
          };
        },
      },
    });

    try {
      await expect(
        agent.command({ bindingId: "tg", chatId: "42" }, "model", undefined)
      ).resolves.toBe(true);

      expect(enqueued).toMatchObject([
        {
          bindingId: "tg",
          chatId: "42",
          delivery: {
            kind: "message",
            modelPicker: {
              current: { id: llm.modelId, provider: FAKE_PROVIDER },
              models: [
                {
                  id: llm.modelId,
                  name: llm.faux.getModel().name,
                  provider: FAKE_PROVIDER,
                },
              ],
            },
            source: "command",
            text: [
              `Current model: ${FAKE_PROVIDER}/${llm.modelId}`,
              `**${FAKE_PROVIDER}**\n- ${llm.modelId} (current)`,
              "Use /model <id> or /model <provider>/<id> to switch.",
            ].join("\n\n"),
          },
        },
      ]);
    } finally {
      await agent.close();
    }
  });

  it("runs maintenance Runs and Trigger Runs without a Chat and delivers Trigger replies through the outbox", async () => {
    const enqueued: unknown[] = [];

    const agent = await openAgent({
      isDeliverySuppressed: async () => {
        await Promise.resolve();

        return false;
      },
      outbox: {
        enqueue: async (item) => {
          await Promise.resolve();
          enqueued.push(item);

          return {
            attempts: 0,
            bindingId: item.bindingId,
            chatId: item.chatId,
            createdAt: 0,
            delivery: {
              ...item.delivery,
              chatId: item.chatId,
              messageId: "m1",
            },
            deliveryId: "d1",
            lastError: null,
            nextAttemptAt: null,
            permanent: false,
            sourceConversationId: item.sourceConversationId,
            status: "pending",
          };
        },
      },
    });

    try {
      llm.faux.setResponses([
        fauxAssistantMessage("consolidated"),
        fauxAssistantMessage("good morning"),
      ]);

      const { runId } = await agent.maintenance.start({
        job: "memory.consolidate",
        prompt: "Consolidate",
      });

      await expect(agent.maintenance.wait(runId)).resolves.toStrictEqual({
        error: undefined,
        status: "completed",
        text: "consolidated",
      });

      const fired = await agent.triggers.start({
        firingId: "f1",
        prompt: "Say good morning",
        target: { bindingId: "telegram", chatId: "42" },
        trigger: {
          conversationMode: "per_firing",
          createdAt: "2026-11-26T00:00:00.000Z",
          createdBy: "operator",
          id: "t1",
          lastFiredAt: null,
          name: "morning",
          nextFireAt: null,
          paused: false,
          prompt: "Say good morning",
          schedule: { at: "2026-11-26T08:00:00.000Z", kind: "once" },
          target: { bindingId: "telegram", chatId: "42" },
        },
      });

      expect(agent.triggers.isActive("t1")).toBe(true);
      await vi.waitFor(() => {
        expect(enqueued).toHaveLength(1);
      });
      expect(enqueued[0]).toMatchObject({
        bindingId: "telegram",
        chatId: "42",
        delivery: {
          kind: "message",
          runId: fired.runId,
          source: "trigger",
          text: "good morning",
        },
      });
      await vi.waitFor(() => {
        expect(agent.triggers.isActive("t1")).toBe(false);
      });
      expect(agent.getRun(fired.runId).run.origin).toStrictEqual({
        kind: "trigger",
        triggerId: "t1",
      });
    } finally {
      await agent.close();
    }
  });

  it("runs the Memory flush turn before an automatic compaction and keeps it out of the Chat", async () => {
    llm = createFakeLlm({ contextWindow: SMALL_CONTEXT_WINDOW });

    const memory = new InMemoryMemoryStore(undefined, undefined, FLUSH_PROMPT);
    const requests: string[][] = [];

    const respond: FauxResponseFactory = (context) => {
      const texts = context.messages.map(messageText);
      const last = context.messages.at(-1);

      requests.push(texts);

      if (last?.role === "user" && messageText(last) === FLUSH_PROMPT) {
        return fauxAssistantMessage(
          fauxToolCall("write_file", { content: "fact", path: "saved.md" }),
          { stopReason: "toolUse" }
        );
      }

      return fauxAssistantMessage(
        last?.role === "toolResult" ? "flushed" : "ok"
      );
    };

    llm.faux.setResponses(Array.from({ length: 40 }, () => respond));

    const agent = await openAgent({
      memory: agentMemory(memory),
      models: llm.models,
    });

    try {
      for (const [index, word] of [
        "first",
        "second",
        "third",
        "fourth",
      ].entries()) {
        // oxlint-disable-next-line no-await-in-loop -- Each message waits for the previous Run, like a person in a Chat.
        await sendAndFinish(
          agent,
          `${word} ${"x".repeat(LARGE_MESSAGE_CHARS)}`,
          index + 1
        );
      }

      const flushAt = requests.findIndex(
        (texts) => texts.at(-1) === FLUSH_PROMPT
      );

      const summaryAt = requests.findIndex((texts) =>
        texts.some((text) => text.includes(SUMMARY_REQUEST))
      );

      expect(flushAt).toBeGreaterThanOrEqual(0);
      expect(summaryAt).toBeGreaterThan(flushAt);
      // The flush turn sees the messages that the summary replaces, and none that it keeps.
      expect(requests[flushAt]?.some((text) => text.startsWith("first "))).toBe(
        true
      );
      expect(
        requests[flushAt]?.some((text) => text.startsWith("fourth "))
      ).toBe(false);
      await expect(
        readFile(
          path.join(home.dir, "agents", "home", WORKSPACE_DIR, "saved.md"),
          "utf-8"
        )
      ).resolves.toBe("fact");

      const history = await agent.history(CLI_CHAT, undefined, 50);

      expect(history.messages.map((message) => message.text)).not.toContain(
        FLUSH_PROMPT
      );
      expect(history.messages.map((message) => message.text)).not.toContain(
        "flushed"
      );
    } finally {
      await agent.close();
    }
  });

  it("streams run.delta events whose text leads to the reply", async () => {
    llm = createFakeLlm({ tokensPerSecond: 200 });

    const reply = Array.from({ length: 40 }, (_, index) => `word${index}`).join(
      " "
    );

    llm.faux.setResponses([fauxAssistantMessage(reply)]);

    const agent = await openAgent({ models: llm.models });

    try {
      const sent = await agent.send(CLI_CHAT, {
        interactive: true,
        text: "Say many words",
      });

      await vi.waitFor(() => {
        expect(events.of("run.finished")).toHaveLength(1);
      });

      const deltas = events.of("run.delta");
      const streamed = deltas.map(({ delta }) => delta).join("");

      expect(deltas.length).toBeGreaterThan(0);
      expect(deltas.every(({ runId }) => runId === sent.runId)).toBe(true);
      expect(reply.startsWith(streamed)).toBe(true);
    } finally {
      await agent.close();
    }
  });

  it("archives Chat messages and replies in Memory, but not maintenance Runs", async () => {
    const memory = new InMemoryMemoryStore();
    const agent = await openAgent({ memory: agentMemory(memory) });

    try {
      llm.faux.setResponses([
        fauxAssistantMessage("The answer is blue"),
        fauxAssistantMessage("Consolidated notes"),
      ]);

      const sent = await agent.send(CLI_CHAT, {
        interactive: true,
        text: "Which color?",
      });

      await vi.waitFor(() => {
        expect(events.of("run.finished")).toHaveLength(1);
      });

      const { runId } = await agent.maintenance.start({
        job: "memory.consolidate",
        prompt: "Consolidate",
      });

      await agent.maintenance.wait(runId);

      const archived = async (query: string) => {
        const hits = await memory.search(query, {
          limit: 10,
          scope: "conversations",
        });

        return hits.map((hit) =>
          hit.kind === "conversation"
            ? [hit.conversationId, hit.role, hit.snippet]
            : []
        );
      };

      await expect(archived("Which color")).resolves.toStrictEqual([
        [sent.conversationId, "user", "Which color?"],
      ]);
      await expect(archived("answer is blue")).resolves.toStrictEqual([
        [sent.conversationId, "assistant", "The answer is blue"],
      ]);
      await expect(archived("Consolidat")).resolves.toStrictEqual([]);
    } finally {
      await agent.close();
    }
  });

  it("continues an active Run after a restart of the Agent", async () => {
    const first = await openAgent();

    llm.faux.setResponses([
      async (_context, options) => {
        // The request waits until the Harness closes and aborts it.
        if (options?.signal !== undefined && !options.signal.aborted) {
          await once(options.signal, "abort");
        }

        return fauxAssistantMessage("interrupted attempt", {
          stopReason: "aborted",
        });
      },
      fauxAssistantMessage("finished after restart"),
    ]);

    const sent = await first.send(CLI_CHAT, {
      interactive: true,
      text: "Long task",
    });

    await vi.waitFor(() => {
      expect(llm.faux.state.callCount).toBe(1);
    });
    await first.close();

    const second = await openAgent();

    try {
      await vi.waitFor(() => {
        expect(second.getRun(sent.runId).run.status).toBe("completed");
      });
      expect(events.of("chat.message").at(-1)?.message.text).toBe(
        "finished after restart"
      );
    } finally {
      await second.close();
    }
  });

  it("updates saved Conversations when config.model changes across an Agent restart", async () => {
    const first = await openAgent();

    llm.faux.setResponses([fauxAssistantMessage("first reply")]);
    await sendAndFinish(first, "hello", 1);
    await first.close();

    const replacement = fauxProvider({
      models: [{ id: "next-1" }],
      provider: "next-provider",
    });

    replacement.setResponses([fauxAssistantMessage("second reply")]);

    const { models } = llm;

    models.deleteProvider(FAKE_PROVIDER);
    models.setProvider(replacement.provider);

    const second = await openAgent({
      config: {
        model: "next-provider/next-1",
        permissionPolicy: [{ action: "allow", tool: "*" }],
      },
      models,
    });

    try {
      await expect(second.modelPicker(CLI_CHAT)).resolves.toMatchObject({
        current: { id: "next-1", provider: "next-provider" },
      });

      await sendAndFinish(second, "after switch", 2);
      expect(events.of("run.finished").at(-1)?.run.status).toBe("completed");
      expect(events.of("chat.message").at(-1)?.message.text).toBe(
        "second reply"
      );
    } finally {
      await second.close();
    }
  });

  it("keeps a /model override across restarts when still configured, and falls back to config.model when unconfigured", async () => {
    const extra = fauxProvider({
      models: [{ id: "alt-1" }],
      provider: "alt",
    });

    llm.models.setProvider(extra.provider);

    const first = await openAgent();

    await expect(first.command(CLI_CHAT, "model", "alt/alt-1")).resolves.toBe(
      true
    );
    await first.close();

    const second = await openAgent();

    await expect(second.modelPicker(CLI_CHAT)).resolves.toMatchObject({
      current: { id: "alt-1", provider: "alt" },
    });
    await second.close();

    llm.models.deleteProvider("alt");

    const third = await openAgent();

    try {
      await expect(third.modelPicker(CLI_CHAT)).resolves.toMatchObject({
        current: { id: llm.modelId, provider: FAKE_PROVIDER },
      });
    } finally {
      await third.close();
    }
  });

  it("rejects /model for an unconfigured provider and resolves unambiguous shorthand model IDs", async () => {
    const configured = fauxProvider({
      models: [{ id: "unique-model" }, { id: "shared-model" }],
      provider: "configured",
    });

    const alsoConfigured = fauxProvider({
      models: [{ id: "shared-model" }],
      provider: "also-configured",
    });

    const unconfiguredBase = fauxProvider({
      models: [{ id: "locked-1" }],
      provider: "locked",
    });

    llm.models.setProvider(configured.provider);
    llm.models.setProvider(alsoConfigured.provider);
    llm.models.setProvider({
      ...unconfiguredBase.provider,
      auth: {
        apiKey: {
          name: "API key",
          resolve: async () => {
            await Promise.resolve();
          },
        },
      },
    });

    const agent = await openAgent();

    try {
      await expect(
        agent.command(CLI_CHAT, "model", "locked/locked-1")
      ).resolves.toBe(false);
      expect(events.of("chat.message").at(-1)?.message.text).toBe(
        "Provider is not configured: locked"
      );

      await expect(
        agent.command(CLI_CHAT, "model", "unique-model")
      ).resolves.toBe(true);
      expect(events.of("chat.message").at(-1)?.message.text).toBe(
        "This Conversation now uses configured/unique-model."
      );

      await expect(
        agent.command(CLI_CHAT, "model", "shared-model")
      ).resolves.toBe(true);
      expect(events.of("chat.message").at(-1)?.message.text).toBe(
        "This Conversation now uses configured/shared-model."
      );

      await expect(
        agent.command(CLI_CHAT, "model", `${FAKE_PROVIDER}/${llm.modelId}`)
      ).resolves.toBe(true);

      await expect(
        agent.command(CLI_CHAT, "model", "shared-model")
      ).resolves.toBe(false);
      expect(events.of("chat.message").at(-1)?.message.text).toContain(
        "Multiple configured providers offer shared-model:"
      );
    } finally {
      await agent.close();
    }
  });
});
