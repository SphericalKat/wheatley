import { writeFile } from "node:fs/promises";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, it } from "vitest";

import {
  createFakeLlm,
  FAKE_PROVIDER,
  temporaryDir,
} from "../../core/test-support.js";
import type { FakeLlm } from "../../core/test-support.js";
import { startWheatley } from "../../wiring/daemon.js";
import type { WheatleyDaemon } from "../../wiring/daemon.js";
import { DaemonClient } from "../client.js";
import { ChatController } from "./controller.js";
import type { ChatClient, ChatView, Entry } from "./controller.js";
import { lineText } from "./markdown.js";
import { pickerRows } from "./model-picker.js";
import type { ModelPicker } from "./model-picker.js";

let home: Awaited<ReturnType<typeof temporaryDir>>;
let llm: FakeLlm;
let daemon: WheatleyDaemon;
let client: DaemonClient;
let controls: string[];

/** The requests that the controller sent to the daemon, in order. */
let requests: { readonly method: string; readonly params: unknown }[];

const start = async (
  shellAction: "allow" | "ask",
  tokensPerSecond?: number
): Promise<ChatController> => {
  if (tokensPerSecond !== undefined) {
    llm = createFakeLlm({ tokensPerSecond });
  }

  await writeFile(
    path.join(home.dir, "config.yaml"),
    [
      "version: 1",
      "agents:",
      "  home:",
      `    model: ${FAKE_PROVIDER}/${llm.modelId}`,
      "    permissionPolicy:",
      "      - tool: shell",
      `        action: ${shellAction}`,
      "      - tool: '*'",
      "        action: allow",
      "",
    ].join("\n")
  );
  daemon = await startWheatley({
    env: {},
    homeDir: home.dir,
    models: async () => {
      await Promise.resolve();

      return llm.models;
    },
    port: 0,
    version: "test",
  });
  client = await DaemonClient.connect({ url: daemon.server.url }, "test");

  const recording: ChatClient = {
    onEvent: client.onEvent,
    request: async (method, params) => {
      requests.push({ method, params });

      return await client.request(method, params);
    },
  };

  const controller = new ChatController({
    agent: "home",
    client: recording,
    control: (sequence) => {
      controls.push(sequence);
    },
  });

  await controller.start();

  return controller;
};

/** Opens another chat on the running daemon, as a new `wheatley chat` process does. */
const reopen = async (
  request: ChatClient["request"] = client.request
): Promise<ChatController> => {
  const controller = new ChatController({
    agent: "home",
    client: { onEvent: client.onEvent, request },
    control: (sequence) => {
      controls.push(sequence);
    },
  });

  await controller.start();

  return controller;
};

/** Sends each text and waits for its Run to end. */
const chat = async (
  controller: ChatController,
  ...texts: readonly string[]
): Promise<void> => {
  for (const text of texts) {
    // oxlint-disable-next-line no-await-in-loop -- The Runs of one Conversation run one after another.
    await controller.submit(text);
    // oxlint-disable-next-line no-await-in-loop -- The next text waits for this Run.
    await controller.idle;
  }
};

/** Resolves when `predicate` holds for the view. */
const until = async (
  controller: ChatController,
  predicate: (view: ChatView) => boolean
): Promise<ChatView> => {
  if (predicate(controller.view())) {
    return controller.view();
  }

  const { promise, resolve } = Promise.withResolvers<ChatView>();

  const stop = controller.subscribe(() => {
    if (predicate(controller.view())) {
      stop();
      resolve(controller.view());
    }
  });

  return await promise;
};

const shown = (entries: readonly Entry[]): string[] =>
  entries.flatMap((entry) => {
    switch (entry.kind) {
      case "user": {
        return [`user: ${entry.text}`];
      }

      case "reply": {
        return [
          `reply: ${stripVTControlCharacters(entry.lines.map(lineText).join("\n"))}`,
        ];
      }

      case "tool": {
        return [`tool: ${entry.name} ${entry.ok ? "ok" : "failed"}`];
      }

      case "turn": {
        return [`turn: ${entry.tools} tools`];
      }

      case "notice": {
        return [`notice: ${entry.text}`];
      }

      case "shell": {
        return [`shell: ${entry.text}`];
      }

      case "banner":
      case "help": {
        return [];
      }

      default: {
        return [];
      }
    }
  });

beforeEach(async () => {
  home = await temporaryDir();
  llm = createFakeLlm();
  controls = [];
  requests = [];
});

afterEach(async () => {
  await client.close();
  await daemon.close();
  await home.remove();
});

it("shows the model, the reply as rendered Markdown once, the Tool row, and the turn footer", async () => {
  llm.faux.setResponses([
    fauxAssistantMessage([fauxToolCall("shell", { command: "echo hi" })], {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("**Done.** The shell said hi."),
  ]);
  const controller = await start("allow");

  expect(controller.view().model).toBe(`${FAKE_PROVIDER}/${llm.modelId}`);

  await controller.submit("run echo");

  const view = await until(controller, (current) =>
    current.entries.some((entry) => entry.kind === "turn")
  );

  expect(shown(view.entries)).toStrictEqual([
    "user: run echo",
    "tool: shell ok",
    "reply: Done. The shell said hi.",
    "turn: 1 tools",
  ]);
  expect(view.usage.runs).toBe(1);
  expect(view.activity).toBeUndefined();
});

it("does not send an unknown command and suggests the closest one", async () => {
  const controller = await start("allow");

  await controller.submit("/stpo");

  expect(shown(controller.view().entries)).toStrictEqual([
    "user: /stpo",
    "notice: Unknown command /stpo. Nothing was sent. Did you mean /stop?",
  ]);
  await expect(
    client.request("chat.history", { agent: "home", limit: 10 })
  ).resolves.toMatchObject({ messages: [] });
});

it("runs a !command in a local shell without the Agent", async () => {
  const controller = await start("allow");

  await controller.submit("!echo from the shell");

  const view = await until(controller, (current) =>
    current.entries.some(
      (entry) => entry.kind === "notice" && entry.text.startsWith("exit 0")
    )
  );

  expect(shown(view.entries).slice(0, 2)).toStrictEqual([
    "user: !echo from the shell",
    "shell: from the shell",
  ]);
  expect(llm.faux.state.callCount).toBe(0);
});

it("shows an open Approval, rings the bell, and resumes the Run after the decision", async () => {
  llm.faux.setResponses([
    fauxAssistantMessage(
      [fauxToolCall("shell", { command: "echo approved" })],
      { stopReason: "toolUse" }
    ),
    fauxAssistantMessage("Finished."),
  ]);
  const controller = await start("ask");

  await controller.submit("needs approval");

  const asking = await until(
    controller,
    (current) => current.approval !== undefined
  );

  expect(asking.approval?.toolName).toBe("shell");
  expect(
    controls.some((sequence) => sequence.includes("shell needs approval"))
  ).toBe(true);

  await controller.decide("allow_once");

  const done = await until(controller, (current) =>
    current.entries.some((entry) => entry.kind === "turn")
  );

  expect(done.approval).toBeUndefined();
  expect(shown(done.entries)).toContain("reply: Finished.");
});

it("shows a streamed reply exactly once, even when the final text arrives before the last deltas", async () => {
  const reply = [
    "## Plan",
    "",
    "- first step",
    "- second step",
    "",
    "```sh",
    "ls",
    "```",
    "Done.",
  ].join("\n");

  const controller = await start("allow", 400);

  llm.faux.setResponses([fauxAssistantMessage(reply)]);
  await controller.submit("plan it");

  const view = await until(controller, (current) =>
    current.entries.some((entry) => entry.kind === "turn")
  );

  const text = view.entries
    .flatMap((entry) =>
      entry.kind === "reply"
        ? entry.lines.map((line) => stripVTControlCharacters(lineText(line)))
        : []
    )
    .join("\n");

  expect(text).toBe(
    [
      "Plan",
      "",
      "• first step",
      "• second step",
      "",
      "╭─ sh",
      "│ ls",
      "╰─",
      "Done.",
    ].join("\n")
  );
});

it("renders a streamed table, nested list, and multi-line quote as whole blocks", async () => {
  const reply = [
    "| Step | Done |",
    "| --- | --: |",
    "| plan | yes |",
    "",
    "- outer",
    "  - inner",
    "",
    "> first line",
    "> second line",
    "",
    "```sh",
    "ls",
    "```",
  ].join("\n");

  const controller = await start("allow", 40);
  const liveFrames: string[] = [];

  controller.subscribe(() => {
    liveFrames.push(
      stripVTControlCharacters(controller.view().live.map(lineText).join("\n"))
    );
  });

  llm.faux.setResponses([fauxAssistantMessage(reply)]);
  await controller.submit("show me");

  const view = await until(controller, (current) =>
    current.entries.some((entry) => entry.kind === "turn")
  );

  const text = view.entries
    .flatMap((entry) =>
      entry.kind === "reply"
        ? entry.lines.map((line) => stripVTControlCharacters(lineText(line)))
        : []
    )
    .join("\n");

  expect(text).toBe(
    [
      "Step │ Done",
      "─────┼─────",
      "plan │  yes",
      "",
      "• outer",
      "  • inner",
      "",
      "▎ first line",
      "▎ second line",
      "",
      "╭─ sh",
      "│ ls",
      "╰─",
    ].join("\n")
  );
  expect(liveFrames.some((frame) => frame.includes("╭─ sh"))).toBe(true);
  expect(liveFrames.filter((frame) => frame.includes("```"))).toStrictEqual([]);
});

/** A second provider, so the picker shows two groups. Its models sort after the fake LLM's provider. */
const addZetaProvider = (): void => {
  llm.models.setProvider(
    fauxProvider({
      models: [
        { id: "z-1", name: "Zeta One" },
        { id: "z-2", name: "Zeta Two" },
      ],
      provider: "zeta",
    }).provider
  );
};

const commandsSent = (): unknown[] =>
  requests.flatMap(({ method, params }) =>
    method === "chat.command" ? [params] : []
  );

const pickerLines = (picker: ModelPicker | undefined): string[] =>
  picker === undefined
    ? []
    : pickerRows(picker).map((row) =>
        row.kind === "provider"
          ? row.provider
          : `${row.selected ? "›" : " "} ${row.model.id}${row.current ? " (current)" : ""}`
      );

it("opens the /model picker on the current model and switches to the model chosen after a filter", async () => {
  addZetaProvider();
  const controller = await start("allow");

  await controller.submit("/model");

  expect(pickerLines(controller.view().picker)).toStrictEqual([
    FAKE_PROVIDER,
    `› ${llm.modelId} (current)`,
    "zeta",
    "  z-1",
    "  z-2",
  ]);
  expect(commandsSent()).toStrictEqual([]);

  for (const text of "two") {
    controller.editPicker({ kind: "type", text });
  }

  expect(pickerLines(controller.view().picker)).toStrictEqual([
    "zeta",
    "› z-2",
  ]);

  await controller.choosePicker();

  const view = await until(controller, (current) =>
    shown(current.entries).includes(
      "reply: This Conversation now uses zeta/z-2."
    )
  );

  expect(view.picker).toBeUndefined();
  expect(view.model).toBe("zeta/z-2");
  expect(commandsSent()).toStrictEqual([
    { agent: "home", args: "zeta/z-2", name: "model" },
  ]);
  await expect(
    client.request("models.list", { agent: "home" })
  ).resolves.toMatchObject({ current: { id: "z-2", provider: "zeta" } });
});

it("closes the /model picker on cancel without a command or a model change", async () => {
  addZetaProvider();
  const controller = await start("allow");

  await controller.submit("/model");
  controller.editPicker({ kind: "move", step: 1 });
  controller.cancelPicker();

  expect(controller.view().picker).toBeUndefined();
  expect(shown(controller.view().entries)).toStrictEqual([
    "user: /model",
    "notice: The model did not change.",
  ]);
  expect(commandsSent()).toStrictEqual([]);
  await expect(
    client.request("models.list", { agent: "home" })
  ).resolves.toMatchObject({
    current: { id: llm.modelId, provider: FAKE_PROVIDER },
  });
});

it("shows the Agent's /model reply instead of a picker when no model is available", async () => {
  const controller = await start("allow");

  llm.models.deleteProvider(FAKE_PROVIDER);
  await controller.submit("/model");

  const view = await until(controller, (current) =>
    current.entries.some((entry) => entry.kind === "reply")
  );

  expect(view.picker).toBeUndefined();
  expect(commandsSent()).toStrictEqual([{ agent: "home", name: "model" }]);
  expect(shown(view.entries)).toContain(
    `reply: Current model: ${FAKE_PROVIDER}/${llm.modelId}\n\nNo providers have credentials configured.`
  );
});

it("sends /model with an argument to the Agent without a picker", async () => {
  addZetaProvider();
  const controller = await start("allow");

  await controller.submit("/model zeta/z-1");

  const view = await until(controller, (current) =>
    shown(current.entries).includes(
      "reply: This Conversation now uses zeta/z-1."
    )
  );

  expect(view.picker).toBeUndefined();
  expect(view.model).toBe("zeta/z-1");
  expect(requests.map(({ method }) => method)).not.toContain("models.list");
  expect(commandsSent()).toStrictEqual([
    { agent: "home", args: "zeta/z-1", name: "model" },
  ]);
});

it("shows the earlier messages after the banner when the chat opens again, and /copy copies the last reply", async () => {
  llm.faux.setResponses([
    fauxAssistantMessage("First **answer**."),
    fauxAssistantMessage("Second answer."),
  ]);
  const first = await start("allow");

  await chat(first, "first question", "second question");

  const resumed = await reopen();
  const { entries } = resumed.view();

  expect(entries[0]?.kind).toBe("banner");
  expect(shown(entries)).toStrictEqual([
    "user: first question",
    "reply: First answer.",
    "user: second question",
    "reply: Second answer.",
  ]);

  await resumed.submit("/copy");

  expect(controls.at(-1)).toBe(
    `\u001B]52;c;${Buffer.from("Second answer.").toString("base64")}\u0007`
  );
});

it("shows a notice before the earlier messages when the Conversation has more of them", async () => {
  const questions = Array.from({ length: 26 }, (_, index) => `q${index}`);

  llm.faux.setResponses(
    questions.map((_, index) => fauxAssistantMessage(`a${index}`))
  );
  const first = await start("allow");

  await chat(first, ...questions);

  const resumed = await reopen();
  const lines = shown(resumed.view().entries);

  expect(lines).toHaveLength(51);
  expect(lines.slice(0, 3)).toStrictEqual([
    "notice: Showing the last 50 messages. Earlier messages remain in this Conversation.",
    "user: q1",
    "reply: a1",
  ]);
  expect(lines.at(-1)).toBe("reply: a25");
});

it("shows no earlier messages after /new", async () => {
  llm.faux.setResponses([fauxAssistantMessage("Old answer.")]);
  const first = await start("allow");

  await chat(first, "old question");
  await first.submit("/new");

  const resumed = await reopen();
  const lines = shown(resumed.view().entries);

  expect(lines).not.toContain("user: old question");
  expect(lines).not.toContain("reply: Old answer.");
});

it("shows a message once when its event arrives while the history loads", async () => {
  llm.faux.setResponses([fauxAssistantMessage("Live answer.")]);
  await start("allow");

  const resumed = await reopen(async (method, params) => {
    if (method === "chat.history") {
      const { promise, resolve } = Promise.withResolvers<undefined>();

      const stop = client.onEvent((event) => {
        if (event.name === "run.finished") {
          stop();
          resolve(undefined);
        }
      });

      await client.request("chat.send", {
        agent: "home",
        text: "from the dashboard",
      });
      await promise;
    }

    return await client.request(method, params);
  });

  expect(shown(resumed.view().entries)).toStrictEqual([
    "user: from the dashboard",
    "reply: Live answer.",
    "turn: 0 tools",
  ]);
});
