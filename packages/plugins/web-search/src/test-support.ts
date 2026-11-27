import type { Logger, Tool, ToolContext } from "@wheatley-ai/sdk";

import plugin from "./index.js";
import type { WebSearchConfig } from "./index.js";

const ignore = (): void => undefined;

const silentLog: Logger = {
  debug: ignore,
  error: ignore,
  info: ignore,
  warn: ignore,
};

/** A Tool call context for tests. */
export const toolContext = (
  signal = new AbortController().signal
): ToolContext => ({
  agentName: "home",
  chat: null,
  conversationId: "conversation-1",
  log: silentLog,
  runId: "run-1",
  signal,
  toolCallId: "call-1",
  workspaceDir: "/tmp",
});

/** Runs `setup` of the Plugin and returns its Tool `name`. */
export const pluginTool = async (
  name: "search" | "fetch",
  config: WebSearchConfig = {},
  secrets: Readonly<Record<string, string>> = {}
): Promise<Tool> => {
  const contributions = await plugin.setup({
    agentName: "home",
    config,
    dataDir: "/tmp",
    log: silentLog,
    secrets: { get: (secret) => secrets[secret] },
    signal: new AbortController().signal,
  });

  const tool = contributions.tools?.find((item) => item.name === name);

  if (tool === undefined) {
    throw new Error(`The Plugin has no Tool ${name}`);
  }

  return tool;
};

/** Returns the text of a single-block Tool result. */
export const resultText = (result: {
  readonly content: readonly {
    readonly type: string;
    readonly text?: string;
  }[];
}): string => result.content.map((block) => block.text ?? "").join("");
