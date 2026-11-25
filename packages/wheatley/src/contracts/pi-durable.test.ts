// Checks the @earendil-works/pi-durable 1.6.1 behavior that Wheatley's Agent relies on (ADR 0001, ADR 0003, ADR 0011),
// against the real package. Production code imports pi-durable only in the Agent's pi adapter.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai";
import {
  CompactionTask,
  createRegistry,
  defineExtension,
  defineSignal,
  defineTask,
  Harness,
  hook,
} from "@earendil-works/pi-durable";
import type {
  HarnessOptions,
  ModelRef,
  TaskId,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { obj, str } from "@earendil-works/pi-schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const context = BACKGROUND_CONTEXT;
const HOUR_MS = 3_600_000;
const SUMMARY = "Wheatley smoke summary";

const ApprovalSignal = defineSignal({
  name: "wheatley.smoke.approval",
  schema: obj({ decision: str() }),
  version: 1,
});

type WaitCheckpoint =
  | { readonly phase: "ask" }
  | { readonly phase: "answered" };

/** Parks in a durable signal sleep, the way a gated tool call waits for an Approval. */
const WaitForApproval = defineTask<
  { readonly key: string },
  WaitCheckpoint,
  string | null
>({
  abort: async (_task, runtime, taskContext) => {
    await runtime.commit(
      () => ({ outcome: { status: "aborted" }, status: "terminal" }),
      taskContext
    );
  },
  initial: () => ({ phase: "ask" }),
  name: "wheatley.smoke.wait-for-approval",
  phases: {
    answered: async (task, runtime, taskContext) => {
      const state = await runtime.readSignal(
        ApprovalSignal,
        task.input.key,
        taskContext
      );

      const result = state?.kind === "value" ? state.value.decision : null;

      await runtime.commit(
        () => ({
          outcome: { result, status: "completed" },
          status: "terminal",
        }),
        taskContext
      );
    },
    ask: async (task, runtime, taskContext) => {
      await runtime.commit(
        () => ({
          checkpoint: { phase: "answered" },
          signals: [ApprovalSignal.key(task.input.key)],
          status: "sleeping",
          until: runtime.now() + HOUR_MS,
        }),
        taskContext
      );
    },
  },
  version: 1,
});

const compactionReasons: string[] = [];

const SmokeExtension = defineExtension({
  hooks: [
    hook(CompactionTask, {
      beforeCompact: (compaction) => {
        compactionReasons.push(compaction.reason);

        return { kind: "summary", summary: SUMMARY };
      },
    }),
  ],
  name: "wheatley-smoke",
  tasks: [WaitForApproval],
});

let dir = "";
let faux = fauxProvider();
let options: HarnessOptions;
let model: ModelRef;

const openHarness = async (): Promise<Harness> =>
  await Harness.open(
    await openNodeSqliteStorage(path.join(dir, "harness.sqlite")),
    options,
    context
  );

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "wheatley-pi-durable-"));
  faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(SmokeExtension);
  model = { modelId: faux.getModel().id, provider: faux.getModel().provider };
  options = {
    models,
    registry,
    settings: { compaction: { enabled: false, keepRecentTokens: 1 } },
  };
  compactionReasons.length = 0;
});

afterEach(async () => {
  await rm(dir, { force: true, recursive: true });
});

describe("@earendil-works/pi-durable 1.6.1", () => {
  it("opens a Harness on node:sqlite storage and answers an input", async () => {
    const harness = await openHarness();

    try {
      faux.setResponses([fauxAssistantMessage("Paris")]);
      const root = await harness.root(context, { agent: { model } });

      const submission = await root.submit(
        { content: "Capital of France?", type: "input" },
        context
      );

      await expect(submission.wait(context)).resolves.toMatchObject({
        status: "done",
        type: "input",
      });
      expect(faux.state.callCount).toBe(1);
    } finally {
      await harness.close(context);
    }
  });

  it("keeps a signal sleep across a reopen and wakes it with the delivered value", async () => {
    const first = await openHarness();
    let taskId: TaskId<string | null>;

    try {
      const root = await first.root(context, { agent: { model } });
      taskId = await root.commit(
        async (tx) =>
          await tx.createTask(
            WaitForApproval,
            { key: "approval-1" },
            { ownership: { kind: "conversation" } }
          ),
        context
      );
      first.resume();

      await vi.waitFor(async () => {
        const task = await first.getTask(taskId, context);

        expect(task?.state.status).toBe("sleeping");
      });
      expect(first.wake().at).toBeGreaterThan(Date.now());
    } finally {
      await first.close(context);
    }

    const second = await openHarness();

    try {
      await expect(
        second.signal(
          taskId,
          ApprovalSignal,
          "approval-1",
          { decision: "allow_once" },
          context
        )
      ).resolves.toBe("delivered");
      await expect(
        second.signal(
          taskId,
          ApprovalSignal,
          "approval-1",
          { decision: "deny" },
          context
        )
      ).resolves.toBe("duplicate");

      const settled = await second.waitForTask(taskId, context);

      expect(settled.state.outcome).toStrictEqual({
        result: "allow_once",
        status: "completed",
      });
    } finally {
      await second.close(context);
    }
  });

  it("runs a beforeCompact hook that supplies the summary without a model call", async () => {
    const harness = await openHarness();

    try {
      faux.setResponses([
        fauxAssistantMessage("First answer"),
        fauxAssistantMessage("Second answer"),
      ]);
      const root = await harness.root(context, { agent: { model } });

      const first = await root.submit(
        { content: "First question", type: "input" },
        context
      );

      await first.wait(context);

      const second = await root.submit(
        { content: "Second question", type: "input" },
        context
      );

      await second.wait(context);

      const compactionId = await root.compact(undefined, context);
      const settled = await harness.waitForTask(compactionId, context);

      expect(settled.state.outcome.status).toBe("completed");
      expect(compactionReasons).toStrictEqual(["manual"]);
      expect(faux.state.callCount).toBe(2);

      await root.waitForIdle(context);
      const view = await root.context(context);

      expect(view.head?.kind).toBe("pi.compaction");
      expect(JSON.stringify(view.messages)).toContain(SUMMARY);
    } finally {
      await harness.close(context);
    }
  });
});
