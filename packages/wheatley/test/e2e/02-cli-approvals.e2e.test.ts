// Flow 2 of issue #50: CLI `chat` and `ask` with `read_file`, `write_file`, and `shell`, and serialized Approval
// prompts for every decision (`allow_once`, `allow_conversation`, `allow_always`, `deny`, timeout).
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type {
  FauxResponseFactory,
  ToolCall,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import { afterEach, expect, it } from "vitest";

import { parseConfigText } from "../../src/core/config/validate.js";
import { ensureDir, startHarness, waitFor } from "./harness.js";
import type { CliSession, Harness, HarnessAgentConfig } from "./harness.js";

const AGENT = "home";

/** The question that the CLI prints for each Approval. */
const APPROVAL_PROMPT = /Approval needed for (?<tool>\S+)/gu;

/** How long the test waits to show that a second prompt does not appear. */
const QUIET_MS = 500;

/** The Approval timeout of the timeout test. */
const SHORT_TIMEOUT = "1s";

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

/**
 * Starts a Deployment with one Agent. Its empty policy keeps the default actions of the built-in Tools: `read_file`
 * allows, and `write_file` and `shell` ask.
 */
const start = async (config: HarnessAgentConfig = {}): Promise<Harness> => {
  harness = await startHarness({
    agents: { [AGENT]: { permissionPolicy: [], ...config } },
    dashboardDir: null,
  });

  return harness;
};

const toolCalls = (...calls: ToolCall[]) =>
  fauxAssistantMessage(calls, { stopReason: "toolUse" });

/** Whitespace runs, which the model reply collapses so each reply prints on one line. */
const WHITESPACE = /\s+/gu;

const textOf = (content: readonly { type: string; text?: string }[]): string =>
  content
    .map((block) => block.text ?? "")
    .join("")
    .replaceAll(WHITESPACE, " ");

/**
 * A model reply that reports each Tool result after the last user message on one line, as `<tool> ok|error: <text>`.
 * The test reads the reply to see what the model got for each call.
 */
const reportToolResults: FauxResponseFactory = (context: TranscriptContext) => {
  const lastUser = context.messages.findLastIndex(
    (message) => message.role === "user"
  );

  const lines = context.messages
    .slice(lastUser + 1)
    .flatMap((message) =>
      message.role === "toolResult"
        ? [
            `${message.toolName} ${message.isError ? "error" : "ok"}: ${textOf(message.content)}`,
          ]
        : []
    );

  return fauxAssistantMessage(`Results: ${lines.join(" | ")}`);
};

const promptsIn = (output: string): string[] =>
  [...output.matchAll(APPROVAL_PROMPT)].map(
    (match) => match.groups?.tool ?? ""
  );

/** Resolves with the Tool name of prompt number `count` (1-based) once the CLI printed it. */
const waitForPrompt = async (
  session: CliSession,
  count: number
): Promise<string> =>
  await waitFor(
    () => promptsIn(session.stdout())[count - 1],
    `Approval prompt ${count}`
  );

/** A reply of `reportToolResults` in the chat output. A prompt without a line break can precede it on its line. */
const CHAT_REPLY = /home> Results:[^\n]*/gu;

/** Resolves with reply number `count` (1-based) once the CLI printed it. */
const waitForReply = async (
  session: CliSession,
  count: number
): Promise<string> =>
  await waitFor(
    () => [...session.stdout().matchAll(CHAT_REPLY)][count - 1]?.[0],
    `reply ${count}`
  );

const exists = async (file: string): Promise<boolean> => {
  try {
    await stat(file);

    return true;
  } catch {
    return false;
  }
};

/** The Agent's `permissionPolicy` in `config.yaml` on disk. */
const policyOf = async (homeDir: string) => {
  const parsed = parseConfigText(
    await readFile(path.join(homeDir, "config.yaml"), "utf-8")
  );

  return parsed.ok ? parsed.config.agents[AGENT]?.permissionPolicy : undefined;
};

it("runs read_file without a prompt and asks for write_file and shell one at a time in chat (allow_once, deny)", async () => {
  const h = await start();
  const workspace = await ensureDir(h.workspaceDir());

  await writeFile(path.join(workspace, "notes.txt"), "remember the milk");

  const rpc = await h.connect();

  h.llm.faux.setResponses([
    toolCalls(
      fauxToolCall("read_file", { path: "notes.txt" }),
      fauxToolCall("write_file", { content: "copied", path: "copy.txt" }),
      fauxToolCall("shell", { command: "echo shell-ran > shell.txt" })
    ),
    reportToolResults,
    toolCalls(
      fauxToolCall("write_file", { content: "again", path: "two.txt" })
    ),
    reportToolResults,
  ]);

  const chat = h.cliSession(["chat", "--agent", AGENT]);

  await chat.waitForOutput(/Chat with home/u);
  chat.write("Copy my notes and run a command");

  const first = await waitForPrompt(chat, 1);

  // Serialized: the second asking call waits behind the first Approval, so only one prompt shows.
  await delay(QUIET_MS);
  expect(promptsIn(chat.stdout())).toEqual([first]);

  chat.write("o");

  const second = await waitForPrompt(chat, 2);

  expect([first, second].toSorted()).toEqual(["shell", "write_file"]);
  chat.write("once");

  const reply = await waitForReply(chat, 1);

  expect(reply).toContain("read_file ok: remember the milk");
  expect(reply).toMatch(/write_file ok: Wrote 6 bytes/u);
  expect(reply).toContain("shell ok");
  expect(promptsIn(chat.stdout())).toHaveLength(2);
  await expect(
    readFile(path.join(workspace, "copy.txt"), "utf-8")
  ).resolves.toBe("copied");
  await expect(
    readFile(path.join(workspace, "shell.txt"), "utf-8")
  ).resolves.toBe("shell-ran\n");

  // allow_once does not carry over to the next call of the same Tool.
  chat.write("Write another file");
  await waitForPrompt(chat, 3);
  chat.write("d not in this folder");

  const denied = await waitForReply(chat, 2);

  expect(denied).toMatch(/write_file error: .*not in this folder/u);
  expect(await exists(path.join(workspace, "two.txt"))).toBe(false);

  chat.write("/exit");
  await expect(chat.result).resolves.toMatchObject({ code: 0 });

  const decisions = rpc.events.flatMap((event) =>
    event.name === "approval.resolved"
      ? [[event.payload.decision, event.payload.reason ?? null]]
      : []
  );

  expect(decisions).toEqual([
    ["allow_once", null],
    ["allow_once", null],
    ["deny", "not in this folder"],
  ]);
});

it("keeps an allow_conversation grant for the Conversation and clears it on /new", async () => {
  const h = await start();
  const workspace = await ensureDir(h.workspaceDir());

  h.llm.faux.setResponses([
    toolCalls(fauxToolCall("shell", { command: "echo one > one.txt" })),
    reportToolResults,
    toolCalls(fauxToolCall("shell", { command: "echo two > two.txt" })),
    reportToolResults,
    toolCalls(fauxToolCall("shell", { command: "echo three > three.txt" })),
    reportToolResults,
  ]);

  const chat = h.cliSession(["chat", "--agent", AGENT]);

  await chat.waitForOutput(/Chat with home/u);
  chat.write("Run one");
  await expect(waitForPrompt(chat, 1)).resolves.toBe("shell");
  chat.write("c");
  await waitForReply(chat, 1);

  // The grant covers the next shell call of the same Conversation.
  chat.write("Run two");
  await expect(waitForReply(chat, 2)).resolves.toContain("shell ok");
  expect(promptsIn(chat.stdout())).toHaveLength(1);

  chat.write("/new");
  chat.write("Run three");
  await expect(waitForPrompt(chat, 2)).resolves.toBe("shell");
  chat.write("deny");
  await expect(waitForReply(chat, 3)).resolves.toContain("shell error");

  chat.write("/exit");
  await expect(chat.result).resolves.toMatchObject({ code: 0 });

  await expect(
    readFile(path.join(workspace, "one.txt"), "utf-8")
  ).resolves.toBe("one\n");
  await expect(
    readFile(path.join(workspace, "two.txt"), "utf-8")
  ).resolves.toBe("two\n");
  expect(await exists(path.join(workspace, "three.txt"))).toBe(false);
});

it("applies allow_always to the live policy and prepends it to config.yaml", async () => {
  const h = await start({
    permissionPolicy: [{ action: "ask", tool: "write_file" }],
  });

  const workspace = await ensureDir(h.workspaceDir());

  h.llm.faux.setResponses([
    toolCalls(fauxToolCall("shell", { command: "echo always > a.txt" })),
    reportToolResults,
    toolCalls(fauxToolCall("shell", { command: "echo later > b.txt" })),
    reportToolResults,
  ]);

  const chat = h.cliSession(["chat", "--agent", AGENT]);

  await chat.waitForOutput(/Chat with home/u);
  chat.write("Run it");
  await expect(waitForPrompt(chat, 1)).resolves.toBe("shell");
  chat.write("a");
  await waitForReply(chat, 1);
  chat.write("/exit");
  await expect(chat.result).resolves.toMatchObject({ code: 0 });

  await expect(policyOf(h.homeDir)).resolves.toEqual([
    { action: "allow", tool: "shell" },
    { action: "ask", tool: "write_file" },
  ]);

  // The live policy allows shell at once, without a restart, even for a Run that cannot ask.
  const asked = await h.cli(["ask", "--agent", AGENT, "Run it later"]);

  expect(asked.code).toBe(0);
  expect(asked.stdout).toContain("shell ok");
  expect(asked.stdout).not.toMatch(APPROVAL_PROMPT);
  await expect(readFile(path.join(workspace, "b.txt"), "utf-8")).resolves.toBe(
    "later\n"
  );
});

it("answers Approvals for a terminal ask, with allow_once and a denial reason", async () => {
  const h = await start();
  const workspace = await ensureDir(h.workspaceDir());

  h.llm.faux.setResponses([
    toolCalls(fauxToolCall("shell", { command: "echo yes > yes.txt" })),
    toolCalls(fauxToolCall("write_file", { content: "x", path: "no.txt" })),
    reportToolResults,
  ]);

  const ask = h.cliSession(["ask", "--agent", AGENT, "Do two things"], {
    isTTY: true,
  });

  await expect(waitForPrompt(ask, 1)).resolves.toBe("shell");
  ask.write("o");
  await expect(waitForPrompt(ask, 2)).resolves.toBe("write_file");
  ask.write("d too risky");

  const result = await ask.result;

  expect(result.code).toBe(0);
  expect(result.stdout).toMatch(/write_file error: .*too risky/u);
  await expect(
    readFile(path.join(workspace, "yes.txt"), "utf-8")
  ).resolves.toBe("yes\n");
  expect(await exists(path.join(workspace, "no.txt"))).toBe(false);
});

it("denies a call when its Approval times out", async () => {
  const h = await start({ approvalTimeout: SHORT_TIMEOUT });
  const workspace = await ensureDir(h.workspaceDir());
  const rpc = await h.connect();

  h.llm.faux.setResponses([
    toolCalls(fauxToolCall("shell", { command: "echo late > late.txt" })),
    reportToolResults,
  ]);

  const ask = h.cliSession(["ask", "--agent", AGENT, "Run it"], {
    isTTY: true,
  });

  await expect(waitForPrompt(ask, 1)).resolves.toBe("shell");

  const resolved = await rpc.waitForEvent("approval.resolved");

  expect(resolved.decision).toBe("timeout");
  const { approvals } = await rpc.request("approvals.list", { agent: AGENT });

  expect(approvals).toEqual([]);

  // The answer arrives after the timeout, so the CLI reports that the Approval ended.
  ask.write("o");

  const result = await ask.result;

  expect(result.stdout).toContain("The Approval already ended.");
  expect(result.stdout).toMatch(/shell error: .*timed out/u);
  expect(await exists(path.join(workspace, "late.txt"))).toBe(false);
});

it("auto-denies ask Tools for a non-terminal ask without a prompt", async () => {
  const h = await start();
  const workspace = await ensureDir(h.workspaceDir());
  const rpc = await h.connect();

  h.llm.faux.setResponses([
    toolCalls(
      fauxToolCall("read_file", { path: "missing.txt" }),
      fauxToolCall("write_file", { content: "x", path: "out.txt" }),
      fauxToolCall("shell", { command: "echo no > shell.txt" })
    ),
    reportToolResults,
  ]);

  const result = await h.cli(["ask", "--agent", AGENT, "Try everything"]);

  expect(result.code).toBe(0);
  expect(result.stdout).not.toMatch(APPROVAL_PROMPT);
  expect(result.stdout).toMatch(/write_file error: .*cannot ask/u);
  expect(result.stdout).toMatch(/shell error: .*cannot ask/u);
  expect(await exists(path.join(workspace, "out.txt"))).toBe(false);
  expect(await exists(path.join(workspace, "shell.txt"))).toBe(false);
  expect(
    rpc.events.filter((event) => event.name === "approval.requested")
  ).toEqual([]);
});
