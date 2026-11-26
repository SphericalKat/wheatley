import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { styleText } from "node:util";

import { render } from "ink";

import type { DaemonClient } from "../client.js";
import { GOODBYES, pick } from "../personality.js";
import { ChatApp } from "./app.js";
import { ChatController } from "./controller.js";
import { formatCost, formatCount, formatSeconds } from "./format.js";

/** The file in the Deployment home that keeps the input history of the interactive chat. */
const HISTORY_FILE = "chat_history";

/** Each history entry takes one line, with its newlines escaped. */
const NEWLINE = /\n/gu;
const ESCAPED_NEWLINE = /\\n/gu;
const MS_PER_SECOND = 1000;

const readHistory = async (file: string): Promise<string[]> => {
  try {
    const text = await readFile(file, "utf-8");

    return text
      .split("\n")
      .filter(Boolean)
      .map((line) => line.replaceAll(ESCAPED_NEWLINE, "\n"));
  } catch {
    return [];
  }
};

const writeHistory = async (
  file: string,
  history: readonly string[]
): Promise<void> => {
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      `${history.map((entry) => entry.replaceAll(NEWLINE, "\\n")).join("\n")}\n`,
      { mode: 0o600 }
    );
  } catch {
    // The history is a convenience. A chat without it still works.
  }
};

export interface InteractiveChatOptions {
  readonly agent: string;
  readonly client: DaemonClient;
  readonly home: string;
  readonly version: string;
  readonly streams: {
    readonly input: NodeJS.ReadStream;
    readonly output: NodeJS.WriteStream;
  };
}

/** Runs the interactive terminal chat until the user exits. Resolves with the exit code. */
export const runInteractiveChat = async ({
  agent,
  client,
  home,
  version,
  streams,
}: InteractiveChatOptions): Promise<number> => {
  const controller = new ChatController({
    agent,
    client,
    control: (sequence) => {
      streams.output.write(sequence);
    },
  });

  await controller.start();

  const historyFile = path.join(home, HISTORY_FILE);
  const history = await readHistory(historyFile);
  const startedAt = Date.now();

  const instance = render(
    <ChatApp
      controller={controller}
      history={history}
      onHistory={(next) => {
        void writeHistory(historyFile, next);
      }}
      version={version}
    />,
    { exitOnCtrlC: false, stdin: streams.input, stdout: streams.output }
  );

  await instance.waitUntilExit();

  const { usage } = controller.view();

  const summary = [
    formatSeconds((Date.now() - startedAt) / MS_PER_SECOND),
    usage.runs === 1 ? "1 run" : `${usage.runs} runs`,
    `↑${formatCount(usage.inputTokens)} ↓${formatCount(usage.outputTokens)} tokens`,
    formatCost(usage.costUsd),
  ].join(" · ");

  streams.output.write(
    `\n${styleText("cyan", "◉")} ${styleText("italic", pick(GOODBYES) ?? "")}\n${styleText("dim", `  ${summary}`)}\n`
  );

  return 0;
};
