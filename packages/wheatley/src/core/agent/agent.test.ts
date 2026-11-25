import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InMemoryApprovalGate } from "../../contracts/approval-gate.fake.js";
import { InMemoryConfigStore } from "../../contracts/config-store.fake.js";
import { InMemoryDeliveryOutbox } from "../../contracts/delivery-outbox.fake.js";
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
