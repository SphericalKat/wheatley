import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { BUILTIN_COMMANDS, isDeliveryError } from "@wheatley/sdk";
import type {
  DeliveryError,
  FrontendBinding,
  FrontendContext,
  FrontendSink,
  InboundCommand,
  InboundDecision,
  InboundMessage,
  JsonObject,
  JsonValue,
  MessageDelivery,
} from "@wheatley/sdk";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { InMemorySecretStore } from "../../contracts/secret-store.fake.js";
import { InMemoryWebhookIngress } from "../../contracts/webhook-ingress.fake.js";
import { FakeTelegramClient } from "./client.fake.js";
import { TelegramApiError } from "./client.js";
import type { TelegramMessage, TelegramUpdate } from "./client.js";
import { createTelegramFrontend } from "./frontend.js";

const MIB = 1_048_576;
const BOT_TOKEN = "123456:secret-bot-token";
const DM_CHAT = 42;
const GROUP_CHAT = -1_001_234;
const FORUM_CHAT = -1_009_999;
const encoder = new TextEncoder();

const sender = { first_name: "Ada", id: 7, is_bot: false, last_name: "L" };

interface LogEntry {
  readonly level: string;
  readonly message: string;
  readonly fields: JsonObject | undefined;
}

interface Harness {
  readonly client: FakeTelegramClient;
  readonly binding: FrontendBinding;
  readonly sends: InboundMessage[];
  readonly commands: InboundCommand[];
  readonly decisions: InboundDecision[];
  readonly logs: LogEntry[];
}

interface HarnessOptions {
  readonly config?: JsonObject;
  readonly ctx?: Partial<FrontendContext>;
  readonly decide?: (decision: InboundDecision) => boolean;
  readonly client?: FakeTelegramClient;
}

let workDir = "";
let updateId = 0;
let messageId = 0;

const baseConfig: JsonObject = {
  allowedChatIds: [DM_CHAT, String(GROUP_CHAT), FORUM_CHAT],
  botToken: { secret: "TG_TOKEN" },
};

const contextOf = (
  logs: LogEntry[],
  overrides: Partial<FrontendContext> = {}
): FrontendContext => {
  const log =
    (level: string) =>
    (message: string, fields?: JsonObject): void => {
      logs.push({ fields, level, message });
    };

  return {
    agentName: "home",
    bindingId: "tg",
    dataDir: path.join(workDir, "data"),
    log: {
      debug: log("debug"),
      error: log("error"),
      info: log("info"),
      warn: log("warn"),
    },
    maxAttachmentBytes: 10 * MIB,
    secrets: new InMemorySecretStore({ TG_TOKEN: BOT_TOKEN }),
    stagingDir: path.join(workDir, "staging"),
    ...overrides,
  };
};

const startBinding = async (options: HarnessOptions = {}): Promise<Harness> => {
  const client = options.client ?? new FakeTelegramClient();
  const logs: LogEntry[] = [];
  const sends: InboundMessage[] = [];
  const commands: InboundCommand[] = [];
  const decisions: InboundDecision[] = [];

  const frontend = createTelegramFrontend({
    createClient: async (token) => {
      await Promise.resolve();
      expect(token).toBe(BOT_TOKEN);

      return client;
    },
  });

  const binding = await frontend.createBinding(
    options.config ?? baseConfig,
    contextOf(logs, options.ctx)
  );

  const sink: FrontendSink = {
    command: async (command) => {
      await Promise.resolve();
      commands.push(command);
    },
    commands: BUILTIN_COMMANDS,
    decide: async (decision) => {
      await Promise.resolve();
      decisions.push(decision);

      return options.decide?.(decision) ?? true;
    },
    send: async (message) => {
      await Promise.resolve();
      sends.push(message);
    },
  };

  await binding.start(sink);

  return { binding, client, commands, decisions, logs, sends };
};

const messageUpdate = (
  fields: Partial<TelegramMessage> & Pick<TelegramMessage, "chat">
): TelegramUpdate => {
  updateId += 1;
  messageId += 1;

  return {
    message: { from: sender, message_id: messageId, ...fields },
    update_id: updateId,
  };
};

const dm = (text: string): TelegramUpdate =>
  messageUpdate({ chat: { id: DM_CHAT, type: "private" }, text });

const groupMessage = (fields: Partial<TelegramMessage> = {}): TelegramUpdate =>
  messageUpdate({ chat: { id: GROUP_CHAT, type: "supergroup" }, ...fields });

const mentionOf = (text: string, username: string) => ({
  length: username.length + 1,
  offset: text.indexOf(`@${username}`),
  type: "mention",
});

const message = (
  fields: Partial<MessageDelivery> & { chatId: string }
): MessageDelivery => ({
  kind: "message",
  messageId: `out-${messageId}`,
  source: "reply",
  text: "Hello",
  ...fields,
});

/** Returns the `DeliveryError` that `promise` rejects with. Fails the test for any other outcome. */
const rejection = async (promise: Promise<void>): Promise<DeliveryError> => {
  try {
    await promise;
  } catch (error) {
    if (isDeliveryError(error)) {
      return error;
    }

    throw error;
  }

  throw new Error("Expected a rejection");
};

let harnesses: Harness[] = [];

const harness = async (options: HarnessOptions = {}): Promise<Harness> => {
  const created = await startBinding(options);
  harnesses.push(created);

  return created;
};

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "wheatley-telegram-"));
  // Wheatley creates both directories before it creates a binding.
  await mkdir(path.join(workDir, "data"));
  await mkdir(path.join(workDir, "staging"));
  harnesses = [];
});

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    harnesses.map(async ({ binding }) => {
      await binding.stop();
    })
  );
  await rm(workDir, { force: true, recursive: true });
});

it("rejects a config without allowedChatIds", async () => {
  const frontend = createTelegramFrontend({
    createClient: async () => {
      await Promise.resolve();

      return new FakeTelegramClient();
    },
  });

  const config: JsonValue = {
    allowedChatIds: [],
    botToken: { secret: "TG_TOKEN" },
  };

  await expect(frontend.createBinding(config, contextOf([]))).rejects.toThrow(
    /allowedChatIds/u
  );
});

it("rejects webhook mode without a webhook URL or without the Webhook Ingress", async () => {
  const frontend = createTelegramFrontend({
    createClient: async () => {
      await Promise.resolve();

      return new FakeTelegramClient();
    },
  });

  await expect(
    frontend.createBinding({ ...baseConfig, mode: "webhook" }, contextOf([]))
  ).rejects.toThrow(/webhookUrl/u);
  await expect(
    frontend.createBinding(
      {
        ...baseConfig,
        mode: "webhook",
        webhookUrl: "https://bot.example.com/tg",
      },
      contextOf([])
    )
  ).rejects.toThrow(/Webhook Ingress is disabled/u);
});

it("rejects a binding whose bot token secret is missing", async () => {
  const frontend = createTelegramFrontend({
    createClient: async () => {
      await Promise.resolve();

      return new FakeTelegramClient();
    },
  });

  await expect(
    frontend.createBinding(
      { ...baseConfig, botToken: { secret: "MISSING" } },
      contextOf([])
    )
  ).rejects.toThrow(/MISSING/u);
});

it("forwards DMs from allowed Chats and drops unlisted Chats with an info log", async () => {
  const { client, sends, logs } = await harness();

  await client.push(dm("hi there"));
  await client.push(
    messageUpdate({ chat: { id: 5555, type: "private" }, text: "let me in" })
  );

  expect(sends).toStrictEqual([
    {
      attachments: undefined,
      chatId: "42",
      senderDisplayName: "Ada L",
      text: "hi there",
    },
  ]);
  expect(logs).toContainEqual(
    expect.objectContaining({ fields: { chatId: "5555" }, level: "info" })
  );
  expect(client.sent).toHaveLength(0);
});

it("refuses deliveries to Chats outside allowedChatIds as permanent failures", async () => {
  const { binding, client } = await harness();

  const error = await rejection(binding.deliver(message({ chatId: "5555" })));

  expect(error.kind).toBe("permanent");
  expect(client.sent).toHaveLength(0);
});

it("maps forum topics to their own Chats and allows them through the parent group", async () => {
  const { binding, client, sends } = await harness({
    config: { ...baseConfig, groupActivation: "always" },
  });

  const forum = { id: FORUM_CHAT, is_forum: true, type: "supergroup" };

  await client.push(
    messageUpdate({
      chat: forum,
      is_topic_message: true,
      message_thread_id: 77,
      reply_to_message: { message_id: 77 },
      text: "in a topic",
    })
  );
  await client.push(messageUpdate({ chat: forum, text: "in General" }));
  await binding.deliver(
    message({ chatId: `${FORUM_CHAT}:topic:77`, text: "topic reply" })
  );

  expect(sends.map((sent) => sent.chatId)).toStrictEqual([
    `${FORUM_CHAT}:topic:77`,
    String(FORUM_CHAT),
  ]);
  expect(client.sent).toStrictEqual([
    expect.objectContaining({
      chatId: FORUM_CHAT,
      text: "topic reply",
      threadId: 77,
    }),
  ]);
});

it("answers group messages only when they mention or reply to the bot", async () => {
  const { client, sends } = await harness();
  const { username, id } = client.bot;
  const mentionText = `@${username} what is the time?`;

  await client.push(groupMessage({ text: "just chatting" }));
  await client.push(
    groupMessage({
      entities: [mentionOf(mentionText, username)],
      text: mentionText,
    })
  );
  await client.push(
    groupMessage({
      reply_to_message: {
        from: { first_name: "Wheatley", id, is_bot: true },
        message_id: 1,
      },
      text: "and tomorrow?",
    })
  );

  expect(sends.map((sent) => sent.text)).toStrictEqual([
    "what is the time?",
    "and tomorrow?",
  ]);
});

it("does not treat the first message of a forum topic as a reply to the bot", async () => {
  const { client, sends } = await harness();

  await client.push(
    messageUpdate({
      chat: { id: FORUM_CHAT, is_forum: true, type: "supergroup" },
      is_topic_message: true,
      message_thread_id: 12,
      reply_to_message: {
        from: { first_name: "Wheatley", id: client.bot.id, is_bot: true },
        message_id: 12,
      },
      text: "no mention here",
    })
  );

  expect(sends).toHaveLength(0);
});

it("answers every group message when groupActivation is always", async () => {
  const { client, sends } = await harness({
    config: { ...baseConfig, groupActivation: "always" },
  });

  await client.push(groupMessage({ text: "just chatting" }));

  expect(sends.map((sent) => sent.text)).toStrictEqual(["just chatting"]);
});

it("registers the built-in commands and forwards commands for this bot only", async () => {
  const { client, commands, sends } = await harness();

  await client.push(dm("/model gpt-5"));
  await client.push(groupMessage({ text: `/new@${client.bot.username}` }));
  await client.push(groupMessage({ text: "/new@other_bot" }));

  expect(client.commands.map((command) => command.command)).toStrictEqual(
    BUILTIN_COMMANDS.map((command) => command.name)
  );
  expect(commands).toStrictEqual([
    { args: "gpt-5", chatId: "42", name: "model", senderDisplayName: "Ada L" },
    {
      args: undefined,
      chatId: String(GROUP_CHAT),
      name: "new",
      senderDisplayName: "Ada L",
    },
  ]);
  expect(sends).toHaveLength(0);
});

it("shows typing and throttles draft edits to one per interval", async () => {
  vi.useFakeTimers();
  const { binding, client } = await harness();
  const chatId = String(DM_CHAT);
  const runId = "run-1";

  binding.onEvent?.({ chatId, kind: "run_started", runId });
  binding.onEvent?.({ chatId, delta: "Hel", kind: "text_delta", runId });
  binding.onEvent?.({ chatId, delta: "lo", kind: "text_delta", runId });
  await vi.advanceTimersByTimeAsync(1199);

  expect(client.typing).toStrictEqual([
    { chatId: DM_CHAT, threadId: undefined },
  ]);
  expect(client.sent).toHaveLength(0);

  await vi.advanceTimersByTimeAsync(1);

  expect(client.sent.map((sent) => sent.text)).toStrictEqual(["Hello"]);

  binding.onEvent?.({ chatId, delta: " wor", kind: "text_delta", runId });
  binding.onEvent?.({ chatId, delta: "ld", kind: "text_delta", runId });
  await vi.advanceTimersByTimeAsync(1199);

  expect(client.edits).toHaveLength(0);

  await vi.advanceTimersByTimeAsync(1);

  expect(client.edits.map((edit) => edit.text)).toStrictEqual(["Hello world"]);

  binding.onEvent?.({
    chatId,
    kind: "run_finished",
    runId,
    status: "completed",
  });
  await binding.deliver(message({ chatId, runId, text: "**Hello** world" }));

  expect(client.sent).toHaveLength(1);
  expect(client.edits.at(-1)).toStrictEqual({
    chatId: DM_CHAT,
    messageId: client.sent[0]?.messageId,
    options: { parseMode: "HTML" },
    text: "<b>Hello</b> world",
  });
});

it("shows only the typing indicator in typing mode", async () => {
  vi.useFakeTimers();

  const { binding, client } = await harness({
    config: { ...baseConfig, streaming: "typing" },
  });

  const chatId = String(DM_CHAT);

  binding.onEvent?.({ chatId, kind: "run_started", runId: "run-2" });
  binding.onEvent?.({
    chatId,
    delta: "partial",
    kind: "text_delta",
    runId: "run-2",
  });
  await vi.advanceTimersByTimeAsync(5000);
  binding.onEvent?.({
    chatId,
    kind: "run_finished",
    runId: "run-2",
    status: "completed",
  });
  await binding.deliver(message({ chatId, runId: "run-2", text: "final" }));

  expect(client.typing.length).toBeGreaterThanOrEqual(2);
  expect(client.edits).toHaveLength(0);
  expect(client.sent.map((sent) => sent.text)).toStrictEqual(["final"]);
});

it("stages inbound files up to the attachment limit and reports larger files", async () => {
  const { client, sends } = await harness({ ctx: { maxAttachmentBytes: 8 } });
  client.downloads.set("doc-1", [encoder.encode("abc"), encoder.encode("def")]);
  client.downloads.set("doc-2", [encoder.encode("0123456789")]);

  await client.push(
    messageUpdate({
      caption: "notes",
      chat: { id: DM_CHAT, type: "private" },
      document: {
        file_id: "doc-1",
        file_name: "notes.txt",
        mime_type: "text/plain",
      },
    })
  );
  await client.push(
    messageUpdate({
      chat: { id: DM_CHAT, type: "private" },
      document: { file_id: "doc-2", file_name: "big.bin" },
    })
  );
  await client.push(
    messageUpdate({
      chat: { id: DM_CHAT, type: "private" },
      document: { file_id: "doc-3", file_name: "huge.bin", file_size: 9 },
    })
  );

  const [first] = sends;
  const attachment = first?.attachments?.[0];

  expect(sends).toHaveLength(1);
  expect(first?.text).toBe("notes");
  expect(attachment).toMatchObject({
    filename: "notes.txt",
    kind: "file",
    mimeType: "text/plain",
    sizeBytes: 6,
  });
  expect(
    attachment?.kind === "file" && (await readFile(attachment.path, "utf-8"))
  ).toBe("abcdef");
  expect(await readdir(path.join(workDir, "staging"))).toHaveLength(1);
  expect(client.sent.map((sent) => sent.text)).toStrictEqual([
    "Skipped big.bin: files over 8 bytes are not supported.",
    "Skipped huge.bin: files over 8 bytes are not supported.",
  ]);
});

it("sends outbound attachments after the text and reports attachments over the limit", async () => {
  const { binding, client, logs } = await harness({
    ctx: { maxAttachmentBytes: 4 },
  });

  const chatId = String(DM_CHAT);
  const data = encoder.encode("png!");

  await binding.deliver(
    message({
      attachments: [
        { data, filename: "chart.png", kind: "bytes", mimeType: "image/png" },
      ],
      chatId,
      text: "Here is the chart",
    })
  );

  await binding.deliver(
    message({
      attachments: [
        {
          data: encoder.encode("12345"),
          filename: "big.txt",
          kind: "bytes",
          mimeType: "text/plain",
        },
      ],
      chatId,
      messageId: "out-big",
      text: "Here is the log",
    })
  );

  expect(client.sent.map((sent) => sent.text)).toStrictEqual([
    "Here is the chart",
    "Here is the log",
    "Skipped big.txt: files over 4 bytes are not supported.",
  ]);
  expect(client.files).toStrictEqual([
    {
      chatId: DM_CHAT,
      file: { data, filename: "chart.png" },
      kind: "photo",
      threadId: undefined,
    },
  ]);
  expect(logs).toContainEqual(
    expect.objectContaining({
      fields: { chatId, filenames: ["big.txt"] },
      level: "warn",
    })
  );
});

it("shows Approvals with four buttons and passes button presses to the sink", async () => {
  const { binding, client, decisions } = await harness();
  const chatId = String(DM_CHAT);

  await binding.deliver({
    approvalId: "approval-1",
    chatId,
    expiresAt: null,
    inputPreview: "rm -rf build",
    kind: "approval_requested",
    messageId: "out-approval",
    runId: "run-9",
    toolName: "shell",
  });

  const [prompt] = client.sent;
  const buttons = prompt?.options?.keyboard?.flat() ?? [];

  expect(buttons.map((button) => button.text)).toStrictEqual([
    "Allow once",
    "Allow for chat",
    "Always allow",
    "Deny",
  ]);

  const deny = buttons[3]?.callbackData ?? "";
  updateId += 1;
  await client.push({
    callback_query: {
      data: deny,
      from: sender,
      id: "cb-1",
      message: {
        chat: { id: DM_CHAT, type: "private" },
        message_id: prompt?.messageId ?? 0,
      },
    },
    update_id: updateId,
  });

  expect(decisions).toStrictEqual([
    {
      approvalId: "approval-1",
      chatId,
      resolution: { decision: "deny", resolvedBy: "Ada L" },
    },
  ]);
  expect(client.answers).toStrictEqual([
    { id: "cb-1", text: "Decision recorded." },
  ]);
});

it("ignores Approval buttons pressed in another Chat", async () => {
  const { binding, client, decisions } = await harness();

  await binding.deliver({
    approvalId: "approval-2",
    chatId: String(DM_CHAT),
    expiresAt: null,
    inputPreview: "{}",
    kind: "approval_requested",
    messageId: "out-approval-2",
    runId: "run-9",
    toolName: "shell",
  });
  const allow = client.sent[0]?.options?.keyboard?.[0]?.[0]?.callbackData ?? "";
  updateId += 1;
  await client.push({
    callback_query: {
      data: allow,
      from: sender,
      id: "cb-2",
      message: { chat: { id: GROUP_CHAT, type: "supergroup" }, message_id: 1 },
    },
    update_id: updateId,
  });

  expect(decisions).toHaveLength(0);
  expect(client.answers).toStrictEqual([
    { id: "cb-2", text: "This approval has already ended." },
  ]);
});

it("edits the Approval prompt on resolve, also after a restart", async () => {
  const first = await harness();
  const chatId = String(DM_CHAT);

  await first.binding.deliver({
    approvalId: "approval-3",
    chatId,
    expiresAt: "2026-11-26T12:00:00Z",
    inputPreview: "ls",
    kind: "approval_requested",
    messageId: "out-approval-3",
    runId: "run-9",
    toolName: "shell",
  });
  const promptId = first.client.sent[0]?.messageId;
  await first.binding.stop();
  harnesses = [];

  const second = await harness();
  await second.binding.deliver({
    approvalId: "approval-3",
    chatId,
    decision: "allow_once",
    kind: "approval_resolved",
    messageId: "out-resolved-3",
    resolvedBy: "Ada L",
  });

  expect(second.client.sent).toHaveLength(0);
  expect(second.client.edits).toStrictEqual([
    {
      chatId: DM_CHAT,
      messageId: promptId,
      options: { keyboard: [], parseMode: "HTML" },
      text: "<b>Allowed once</b> by Ada L\nTool: <code>shell</code>\n<pre>ls</pre>",
    },
  ]);
});

it("verifies the secret token of webhook requests", async () => {
  const ingress = new InMemoryWebhookIngress({
    agent: (name) =>
      name === "home"
        ? { state: () => "running", triggers: () => {} }
        : undefined,
    secrets: new InMemorySecretStore(),
  });

  const { client, sends } = await harness({
    config: {
      ...baseConfig,
      mode: "webhook",
      webhookUrl: "https://bot.example.com/tg",
    },
    ctx: {
      registerWebhookRoute: (suffix, handler) =>
        ingress.registerFrontendRoute("home", "tg", suffix, handler),
    },
  });

  const [webhook] = client.webhooks;
  const body = encoder.encode(JSON.stringify(dm("via webhook")));

  const post = async (headers: Readonly<Record<string, string>>) =>
    await ingress.handle({
      body,
      headers,
      method: "POST",
      path: "/frontends/home/tg/updates",
      query: {},
    });

  expect(webhook?.url).toBe("https://bot.example.com/tg");
  expect(await post({})).toStrictEqual({ status: 401 });
  expect(
    await post({ "x-telegram-bot-api-secret-token": "wrong-token" })
  ).toStrictEqual({ status: 401 });
  expect(sends).toHaveLength(0);
  expect(
    await post({
      "x-telegram-bot-api-secret-token": webhook?.secretToken ?? "",
    })
  ).toStrictEqual({ status: 200 });
  expect(sends.map((sent) => sent.text)).toStrictEqual(["via webhook"]);
  expect(client.polling).toBe(false);
});

it("classifies Telegram errors for the outbox", async () => {
  const { binding, client } = await harness();
  const chatId = String(DM_CHAT);
  client.failNext(
    "sendMessage",
    new TelegramApiError("Too Many Requests", {
      code: 429,
      retryAfterSeconds: 3,
    })
  );
  client.failNext(
    "sendMessage",
    new TelegramApiError("Forbidden: bot was blocked by the user", {
      code: 403,
    })
  );
  client.failNext("sendMessage", new TelegramApiError("fetch failed"));

  const limited = await rejection(
    binding.deliver(message({ chatId, messageId: "a" }))
  );

  const blocked = await rejection(
    binding.deliver(message({ chatId, messageId: "b" }))
  );

  const offline = await rejection(
    binding.deliver(message({ chatId, messageId: "c" }))
  );

  expect([limited.kind, limited.retryAfterMs]).toStrictEqual([
    "retryable",
    3000,
  ]);
  expect(blocked.kind).toBe("permanent");
  expect(offline.kind).toBe("retryable");
});

it("drops a repeated delivery of a confirmed message", async () => {
  const { binding, client } = await harness();
  const delivery = message({ chatId: String(DM_CHAT), messageId: "repeat" });

  await binding.deliver(delivery);
  await binding.deliver(delivery);

  expect(client.sent).toHaveLength(1);
});

it("sends the remaining chunks only when a retry follows a partial failure", async () => {
  const { binding, client } = await harness();
  const chatId = String(DM_CHAT);
  const text = `${"a".repeat(3000)}\n\n${"b".repeat(3000)}`;
  const delivery = message({ chatId, messageId: "partial", text });
  const { sendMessage } = client;
  let calls = 0;

  Object.assign(client, {
    sendMessage: async (...args: Parameters<typeof sendMessage>) => {
      calls += 1;

      if (calls === 2) {
        throw new TelegramApiError("Bad Gateway", { code: 502 });
      }

      return await sendMessage(...args);
    },
  });

  const error = await rejection(binding.deliver(delivery));
  await binding.deliver(delivery);

  expect(error.kind).toBe("retryable");
  expect(client.sent.map((sent) => sent.text.charAt(0))).toStrictEqual([
    "a",
    "b",
  ]);
});

it("formats Markdown as Telegram HTML and falls back to plain text if Telegram rejects it", async () => {
  const { binding, client } = await harness();
  const chatId = String(DM_CHAT);
  client.failNext(
    "sendMessage",
    new TelegramApiError("Bad Request: can't parse entities", { code: 400 })
  );

  await binding.deliver(
    message({
      chatId,
      messageId: "md",
      text: "Use `a < b` and [docs](https://x.dev?a=1&b=2)",
    })
  );
  await binding.deliver(
    message({ chatId, messageId: "md-2", text: "```ts\nconst x = 1 < 2;\n```" })
  );

  expect(
    client.sent.map((sent) => [sent.text, sent.options?.parseMode])
  ).toStrictEqual([
    ["Use `a < b` and [docs](https://x.dev?a=1&b=2)", undefined],
    ['<pre><code class="language-ts">const x = 1 &lt; 2;</code></pre>', "HTML"],
  ]);
});
