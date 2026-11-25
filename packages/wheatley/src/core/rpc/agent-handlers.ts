import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AttachmentUpload } from "@wheatley/protocol";

import type { RpcHandlerMap } from "../../contracts/module.js";
import { CLI_CHAT, WORKSPACE_DIR } from "../agent/agent.js";
import type { Agent } from "../agent/agent.js";

/** The default page size of `chat.history` and `runs.list`. */
export const DEFAULT_PAGE_SIZE = 50;

/** The folder inside the workspace that keeps files uploaded with `chat.send` and `chat.ask`. */
export const UPLOADS_DIR = "uploads";

const SAFE_FILENAME = /[^A-Za-z0-9._-]/gu;

/**
 * Stores uploaded files in the Agent workspace and returns the message text with a note that lists their paths, so the
 * model can read them with its Tools.
 */
const withAttachments = async (
  agentDir: string,
  text: string,
  attachments: readonly AttachmentUpload[] | undefined
): Promise<string> => {
  if (attachments === undefined || attachments.length === 0) {
    return text;
  }

  const dir = path.join(agentDir, WORKSPACE_DIR, UPLOADS_DIR);

  await mkdir(dir, { recursive: true });

  const lines = await Promise.all(
    attachments.map(async (attachment) => {
      const file = path.join(
        dir,
        `${randomUUID()}-${attachment.filename.replaceAll(SAFE_FILENAME, "_")}`
      );

      await writeFile(file, Buffer.from(attachment.data, "base64"));

      return `- ${file} (${attachment.mimeType})`;
    })
  );

  return `${text}\n\nAttached files:\n${lines.join("\n")}`;
};

/**
 * The core JSON-RPC handlers of one running Agent: the CLI Chat (`chat.*`), Runs (`runs.*`), and `extensions.list`.
 * The router gives them only requests whose `agent` names this Agent.
 */
export const createAgentRpc = (
  agent: Agent,
  agentDir: string
): RpcHandlerMap => ({
  "chat.ask": async (params) => {
    const sent = await agent.send(CLI_CHAT, {
      interactive: params.interactive,
      senderDisplayName: params.senderDisplayName,
      text: await withAttachments(agentDir, params.text, params.attachments),
    });

    return {
      conversationId: sent.conversationId,
      messageId: sent.messageId,
      runId: sent.runId,
    };
  },
  "chat.command": async (params) => ({
    accepted: await agent.command(CLI_CHAT, params.name, params.args),
  }),
  "chat.history": async (params) =>
    await agent.history(
      CLI_CHAT,
      params.before,
      params.limit ?? DEFAULT_PAGE_SIZE
    ),
  "chat.send": async (params) => {
    const sent = await agent.send(CLI_CHAT, {
      interactive: true,
      senderDisplayName: params.senderDisplayName,
      text: await withAttachments(agentDir, params.text, params.attachments),
    });

    return { messageId: sent.messageId };
  },
  "extensions.list": async () => {
    await Promise.resolve();
    const status = agent.status();

    return {
      frontends: [...status.frontends],
      mcpServers: [...status.mcpServers],
      plugins: [...status.plugins],
      skills: [...agent.extensions.skills()],
      tools: agent.tools(),
    };
  },
  "runs.get": async (params) => {
    await Promise.resolve();

    return agent.getRun(params.runId);
  },
  "runs.list": async (params) => {
    await Promise.resolve();

    return agent.listRuns({
      activeOnly: params.status === "active",
      before: params.before,
      limit: params.limit ?? DEFAULT_PAGE_SIZE,
    });
  },
  "runs.stop": async (params) => ({
    stopped: await agent.stopRun(params.runId),
  }),
});
