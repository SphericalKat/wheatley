import { writeFile } from "node:fs/promises";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
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
import type { ChatView, Entry } from "./controller.js";
import { lineText } from "./markdown.js";

let home: Awaited<ReturnType<typeof temporaryDir>>;
let llm: FakeLlm;
let daemon: WheatleyDaemon;
let client: DaemonClient;
let controls: string[];

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
      "    model:",
      `      provider: ${FAKE_PROVIDER}`,
      `      id: ${llm.modelId}`,
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

  const controller = new ChatController({
    agent: "home",
    client,
    control: (sequence) => {
      controls.push(sequence);
    },
  });

  await controller.start();

  return controller;
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
