import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { FauxResponseFactory, Message } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InMemoryApprovalGate } from "../../contracts/approval-gate.fake.js";
import { InMemoryConfigStore } from "../../contracts/config-store.fake.js";
import { InMemoryDeliveryOutbox } from "../../contracts/delivery-outbox.fake.js";
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

const openAgent = async (
  overrides: Partial<AgentOptions> = {}
): Promise<Agent> =>
  await Agent.open({
    agentDir: path.join(home.dir, "agents", "home"),
    clock: systemClock,
    config: {
      model: { id: llm.modelId, provider: FAKE_PROVIDER },
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
      agents: { home: { model: { id: llm.modelId, provider: FAKE_PROVIDER } } },
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
      config: { model: { id: llm.modelId, provider: FAKE_PROVIDER } },
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
      config: { model: { id: llm.modelId, provider: FAKE_PROVIDER } },
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
      release.resolve(undefined);
      await vi.waitFor(() => {
        expect(events.of("run.finished")).toHaveLength(1);
      });

      expect(agent.getRun(sent.runId).run.status).toBe("stopped");
      await expect(agent.command(CLI_CHAT, "stop", undefined)).resolves.toBe(
        false
      );
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

    const agent = await openAgent({ memory, models: llm.models });

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
    const agent = await openAgent({ memory });

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
});
