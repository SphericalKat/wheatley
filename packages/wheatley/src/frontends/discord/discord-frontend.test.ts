import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";

import type {
  Delivery,
  FrontendBinding,
  FrontendContext,
  FrontendSink,
  InboundCommand,
  InboundDecision,
  InboundMessage,
  JsonObject,
  JsonValue,
} from "@wheatley-ai/sdk";
import { BUILTIN_COMMANDS } from "@wheatley-ai/sdk";
import {
  ApplicationCommandOptionType,
  ButtonStyle,
  ComponentType,
  GatewayIntentBits,
  MessageFlags,
  Partials,
} from "discord.js";
import type {
  ChatInputApplicationCommandData,
  ClientOptions,
} from "discord.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { InboundFile } from "./attachments.js";
import type {
  ButtonInteraction,
  DiscordChannel,
  DiscordClient,
  DiscordInteraction,
  DiscordMessage,
  DiscordRuntime,
  InteractionReceipt,
  OutboundMessage,
  SendableChannel,
  SentMessage,
  SlashCommandInteraction,
} from "./discord-runtime.js";
import { createDiscordFrontend } from "./module.js";

const BOT_ID = "900000000000000001";
const DM = "100";
const CHANNEL = "200";
const THREAD = "300";
const OTHER_CHANNEL = "400";
const OTHER_THREAD = "500";
const MIB = 1024 * 1024;
const MAX_BYTES = 10 * MIB;
const DISCORD_LIMIT = 2000;

const FAKE_TIMERS: (
  | "setTimeout"
  | "clearTimeout"
  | "setInterval"
  | "clearInterval"
  | "Date"
)[] = ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"];

let nextId = 1000;

const newId = (): string => {
  nextId += 1;

  return String(nextId);
};

interface FakeMessage extends SentMessage {
  readonly edits: OutboundMessage[];
  payload: OutboundMessage;
  deleted: boolean;
}

const fakeMessage = (payload: OutboundMessage): FakeMessage => {
  const message: FakeMessage = {
    delete: async () => {
      await Promise.resolve();
      message.deleted = true;

      return message;
    },
    deleted: false,
    edit: async (update) => {
      await Promise.resolve();
      message.edits.push(update);
      message.payload = { ...message.payload, ...update };

      return message;
    },
    edits: [],
    id: newId(),
    payload,
  };

  return message;
};

const apiError = (code: number, status: number): Error =>
  Object.assign(new Error(`Discord API error ${code}`), { code, status });

interface FakeChannel extends SendableChannel {
  readonly sent: FakeMessage[];
  typing: number;
  failure: Error | undefined;
}

const fakeChannel = (
  id: string,
  kind: "dm" | "text" | "thread",
  parentId: string | null = null
): FakeChannel => {
  const channel: FakeChannel = {
    failure: undefined,
    id,
    isDMBased: () => kind === "dm",
    isSendable(): this is SendableChannel {
      return true;
    },
    isThread: () => kind === "thread",
    messages: {
      edit: async (messageId, update) => {
        const message = channel.sent.find(
          (candidate) => candidate.id === messageId
        );

        if (message === undefined) {
          throw apiError(10_008, 404);
        }

        return await message.edit(update);
      },
    },
    parentId,
    send: async (payload) => {
      await Promise.resolve();

      if (channel.failure !== undefined) {
        throw channel.failure;
      }

      const message = fakeMessage(payload);
      channel.sent.push(message);

      return message;
    },
    sendTyping: async () => {
      await Promise.resolve();
      channel.typing += 1;
    },
    sent: [],
    typing: 0,
  };

  return channel;
};

const channels = new Map<string, FakeChannel>();

interface CommandRegistration {
  readonly data: readonly ChatInputApplicationCommandData[];
  readonly guildId: string | undefined;
}

/** A fake Gateway client: it becomes ready after login and records Slash Command registrations. */
interface FakeClient extends DiscordClient {
  readonly token: () => string | undefined;
  readonly destroyed: () => boolean;
  readonly commandSets: CommandRegistration[];
  readonly emitMessage: (message: DiscordMessage) => void;
  readonly emitInteraction: (interaction: DiscordInteraction) => void;
}

const fakeClient = (): FakeClient => {
  const messageListeners: ((message: DiscordMessage) => void)[] = [];

  const interactionListeners: ((interaction: DiscordInteraction) => void)[] =
    [];

  const readyListeners: (() => void)[] = [];
  const commandSets: CommandRegistration[] = [];
  let user: string | undefined;
  let token: string | undefined;
  let destroyed = false;

  return {
    botUserId: () => user,
    commandSets,
    destroy: async () => {
      await Promise.resolve();
      destroyed = true;
    },
    destroyed: () => destroyed,
    emitInteraction: (interaction) => {
      for (const listener of interactionListeners) {
        listener(interaction);
      }
    },
    emitMessage: (message) => {
      for (const listener of messageListeners) {
        listener(message);
      }
    },
    fetchChannel: async (id): Promise<DiscordChannel | null> => {
      await Promise.resolve();

      return channels.get(id) ?? null;
    },
    login: async (value) => {
      await Promise.resolve();
      token = value;

      if (value === "bad-token") {
        throw new Error("An invalid token was provided.");
      }

      setImmediate(() => {
        user = BOT_ID;

        for (const listener of readyListeners.splice(0)) {
          listener();
        }
      });
    },
    onError: () => {},
    onInteraction: (listener) => {
      interactionListeners.push(listener);
    },
    onMessage: (listener) => {
      messageListeners.push(listener);
    },
    onReady: (listener) => {
      readyListeners.push(listener);
    },
    setCommands: async (data, guildId) => {
      await Promise.resolve();
      commandSets.push({ data, guildId });

      return data.length;
    },
    token: () => token,
  };
};

let clients: FakeClient[] = [];
let clientOptions: ClientOptions[] = [];

const runtime: DiscordRuntime = {
  ApplicationCommandOptionType,
  ButtonStyle,
  ComponentType,
  GatewayIntentBits,
  MessageFlags,
  Partials,
  createClient: (options) => {
    clientOptions.push(options);
    const client = fakeClient();
    clients.push(client);

    return client;
  },
};

interface LogRecord {
  readonly level: string;
  readonly message: string;
  readonly fields: JsonObject | undefined;
}

let root = "";
let logs: LogRecord[] = [];
let sent: InboundMessage[] = [];
let commands: InboundCommand[] = [];
let decisions: InboundDecision[] = [];
let decisionWins = true;
let fetchFile = vi.fn<typeof fetch>();
let binding: FrontendBinding | undefined;

const record =
  (level: string) =>
  (message: string, fields?: JsonObject): void => {
    logs.push({ fields, level, message });
  };

const secrets = new Map([
  ["BAD", "bad-token"],
  ["DISCORD_TOKEN", "token-1"],
]);

const context = (): FrontendContext => ({
  agentName: "home",
  bindingId: "discord-main",
  dataDir: path.join(root, "data"),
  log: {
    debug: record("debug"),
    error: record("error"),
    info: record("info"),
    warn: record("warn"),
  },
  maxAttachmentBytes: MAX_BYTES,
  secrets: { get: (name) => secrets.get(name) },
  stagingDir: path.join(root, "staging"),
});

const sink: FrontendSink = {
  command: async (command) => {
    await Promise.resolve();
    commands.push(command);
  },
  commands: BUILTIN_COMMANDS,
  decide: async (decision) => {
    await Promise.resolve();
    decisions.push(decision);

    return decisionWins;
  },
  send: async (message) => {
    await Promise.resolve();
    sent.push(message);
  },
};

const baseConfig = {
  allowedChatIds: [DM, CHANNEL],
  tokenSecret: "DISCORD_TOKEN",
} as const satisfies JsonObject;

const createBinding = async (
  config: JsonValue = baseConfig
): Promise<FrontendBinding> =>
  await createDiscordFrontend({
    fetch: fetchFile,
    loadDiscord: async () => await Promise.resolve(runtime),
  }).createBinding(config, context());

const startBinding = async (
  config: JsonValue = baseConfig
): Promise<FakeClient> => {
  binding = await createBinding(config);
  await binding.start(sink);
  const client = clients.at(-1);

  if (client === undefined) {
    throw new Error("The binding did not create a Discord client");
  }

  return client;
};

const settle = async (): Promise<void> => {
  await nextTurn();
};

const channel = (id: string): FakeChannel => {
  const found = channels.get(id);

  if (found === undefined) {
    throw new Error(`No fake channel ${id}`);
  }

  return found;
};

interface InboundOptions {
  readonly content?: string;
  readonly mentionsBot?: boolean;
  readonly repliesToBot?: boolean;
  readonly bot?: boolean;
  readonly files?: readonly InboundFile[];
}

const inbound = (
  channelId: string,
  options: InboundOptions = {}
): DiscordMessage => {
  const files = new Map((options.files ?? []).map((file) => [file.id, file]));

  return {
    attachments: files,
    author: { bot: options.bot ?? false, displayName: "Ada" },
    channel: channel(channelId),
    content: options.content ?? "hello",
    id: newId(),
    member: null,
    mentions: {
      repliedUser: options.repliesToBot === true ? { id: BOT_ID } : null,
      users: new Set(options.mentionsBot === true ? [BOT_ID] : []),
    },
    system: false,
  };
};

const receipt = async (): Promise<InteractionReceipt> => {
  await Promise.resolve();

  return { id: newId() };
};

const slashCommand = (
  channelId: string,
  commandName: string,
  args: Readonly<Record<string, string>> = {}
) => {
  const interaction = {
    channel: channel(channelId),
    channelId,
    commandName,
    deferReply: vi.fn(receipt),
    editReply: vi.fn(receipt),
    isButton(): this is ButtonInteraction {
      return false;
    },
    isChatInputCommand(): this is SlashCommandInteraction {
      return true;
    },
    options: { getString: (name: string) => args[name] ?? null },
    user: { displayName: "Ada" },
  };

  return interaction satisfies SlashCommandInteraction;
};

const buttonPress = (channelId: string, customId: string) => {
  const interaction = {
    channel: channel(channelId),
    channelId,
    customId,
    deferUpdate: vi.fn(receipt),
    editReply: vi.fn(async (_message: OutboundMessage) => await receipt()),
    followUp: vi.fn(receipt),
    isButton(): this is ButtonInteraction {
      return true;
    },
    isChatInputCommand(): this is SlashCommandInteraction {
      return false;
    },
    message: { content: "prompt" },
    reply: vi.fn(receipt),
    user: { displayName: "Ada" },
  };

  return interaction satisfies ButtonInteraction;
};

const approvalRequest = (approvalId: string): Delivery => ({
  approvalId,
  chatId: CHANNEL,
  expiresAt: "2026-11-26T10:00:00.000Z",
  inputPreview: '{"command":"ls"}',
  kind: "approval_requested",
  messageId: `out-${approvalId}`,
  runId: "run-1",
  toolName: "shell",
});

const buttonsOf = (message: FakeMessage | undefined) =>
  message?.payload.components?.[0]?.components ?? [];

const reply = (messageId: string, chatId: string): Delivery => ({
  chatId,
  kind: "message",
  messageId,
  source: "reply",
  text: "hi",
});

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "wheatley-discord-"));
  logs = [];
  sent = [];
  commands = [];
  decisions = [];
  decisionWins = true;
  fetchFile = vi.fn<typeof fetch>();
  binding = undefined;
  clients = [];
  clientOptions = [];
  channels.clear();

  for (const fake of [
    fakeChannel(DM, "dm"),
    fakeChannel(CHANNEL, "text"),
    fakeChannel(THREAD, "thread", CHANNEL),
    fakeChannel(OTHER_CHANNEL, "text"),
    fakeChannel(OTHER_THREAD, "thread", OTHER_CHANNEL),
  ]) {
    channels.set(fake.id, fake);
  }
});

afterEach(async () => {
  vi.useRealTimers();
  await binding?.stop();
  await rm(root, { force: true, recursive: true });
});

it("rejects a config without allowedChatIds and a token secret that is not set", async () => {
  await expect(
    createBinding({ allowedChatIds: [], tokenSecret: "DISCORD_TOKEN" })
  ).rejects.toThrow(/allowedChatIds/u);
  await expect(
    createBinding({ allowedChatIds: [DM], tokenSecret: "MISSING" })
  ).rejects.toThrow(/MISSING/u);
});

it("logs in with the token secret and destroys the client on stop", async () => {
  const client = await startBinding();
  const [options] = clientOptions;

  expect(client.token()).toBe("token-1");
  // Without these, Discord sends no message text and discord.js drops DMs.
  expect(options?.intents).toStrictEqual(
    expect.arrayContaining([
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ])
  );
  expect(options?.partials).toStrictEqual([Partials.Channel]);

  await binding?.stop();

  expect(client.destroyed()).toBe(true);
});

it("rejects start for a bad token and still stops cleanly", async () => {
  binding = await createBinding({ allowedChatIds: [DM], tokenSecret: "BAD" });

  await expect(binding.start(sink)).rejects.toThrow(/invalid token/u);
  await expect(binding.stop()).resolves.toBeUndefined();
});

it("forwards DMs from allowed Chats and drops other Chats with an info log", async () => {
  const client = await startBinding({
    allowedChatIds: [CHANNEL],
    tokenSecret: "DISCORD_TOKEN",
  });

  client.emitMessage(inbound(DM, { content: "hi" }));
  await settle();

  expect(sent).toStrictEqual([]);
  expect(
    logs
      .filter((entry) => entry.level === "info")
      .map((entry) => entry.fields?.chatId)
  ).toContain(DM);

  await binding?.stop();
  const allowed = await startBinding();
  allowed.emitMessage(inbound(DM, { content: "hi" }));
  await settle();

  expect(sent).toStrictEqual([
    {
      attachments: undefined,
      chatId: DM,
      senderDisplayName: "Ada",
      text: "hi",
    },
  ]);
});

it("maps a thread to its own Chat and allows it through its parent channel", async () => {
  const client = await startBinding();

  client.emitMessage(
    inbound(THREAD, { content: `<@${BOT_ID}> in thread`, mentionsBot: true })
  );
  client.emitMessage(
    inbound(OTHER_THREAD, { content: `<@${BOT_ID}> nope`, mentionsBot: true })
  );
  await settle();

  expect(sent.map((message) => [message.chatId, message.text])).toStrictEqual([
    [THREAD, "in thread"],
  ]);
});

it("answers guild messages only on a mention or a reply to the bot by default", async () => {
  const client = await startBinding();

  client.emitMessage(inbound(CHANNEL, { content: "chatter" }));
  client.emitMessage(
    inbound(CHANNEL, { content: `hey <@!${BOT_ID}> there`, mentionsBot: true })
  );
  client.emitMessage(
    inbound(CHANNEL, { content: "a reply", repliesToBot: true })
  );
  client.emitMessage(
    inbound(CHANNEL, { bot: true, content: "bot", mentionsBot: true })
  );
  await settle();

  expect(sent.map((message) => message.text)).toStrictEqual([
    "hey there",
    "a reply",
  ]);
});

it("answers every guild message with guildMessages all", async () => {
  const client = await startBinding({ ...baseConfig, guildMessages: "all" });

  client.emitMessage(inbound(CHANNEL, { content: "chatter" }));
  await settle();

  expect(sent.map((message) => message.text)).toStrictEqual(["chatter"]);
});

it("turns a built-in command in text into a typed command", async () => {
  const client = await startBinding();

  client.emitMessage(
    inbound(CHANNEL, {
      content: `<@${BOT_ID}> /model gpt-5`,
      mentionsBot: true,
    })
  );
  await settle();

  expect(commands).toStrictEqual([
    {
      args: "gpt-5",
      chatId: CHANNEL,
      name: "model",
      senderDisplayName: "Ada",
    },
  ]);
  expect(sent).toStrictEqual([]);
});

it("registers the built-in commands as global Slash Commands", async () => {
  const client = await startBinding();
  const [registration] = client.commandSets;

  expect(client.commandSets).toHaveLength(1);
  expect(registration?.guildId).toBeUndefined();
  expect(registration?.data.map((command) => command.name)).toStrictEqual(
    BUILTIN_COMMANDS.map((command) => command.name)
  );
  expect(
    registration?.data.find((command) => command.name === "model")?.options
  ).toStrictEqual([
    {
      description: "<model-id>",
      name: "model-id",
      required: false,
      type: ApplicationCommandOptionType.String,
    },
  ]);
});

it("registers Slash Commands per guild with commandGuildIds", async () => {
  const client = await startBinding({
    ...baseConfig,
    commandGuildIds: ["700", "701"],
  });

  expect(
    client.commandSets
      .map((registration) => registration.guildId ?? "")
      .toSorted((left, right) => left.localeCompare(right))
  ).toStrictEqual(["700", "701"]);
});

it("hands a Slash Command to the Agent and answers ephemerally", async () => {
  const client = await startBinding();
  const interaction = slashCommand(THREAD, "goal", { objective: "ship it" });

  client.emitInteraction(interaction);
  await settle();

  expect(commands).toStrictEqual([
    {
      args: "ship it",
      chatId: THREAD,
      name: "goal",
      senderDisplayName: "Ada",
    },
  ]);
  expect(interaction.deferReply).toHaveBeenCalledWith({
    flags: MessageFlags.Ephemeral,
  });
  expect(interaction.editReply).toHaveBeenCalledWith("Accepted `/goal`.");
});

it("drops a Slash Command from a Chat that is not allowed", async () => {
  const client = await startBinding();
  const interaction = slashCommand(OTHER_CHANNEL, "new");

  client.emitInteraction(interaction);
  await settle();

  expect(commands).toStrictEqual([]);
  expect(interaction.deferReply).not.toHaveBeenCalled();
});

it("streams text_delta into one draft that it edits at most once per interval", async () => {
  await startBinding();
  vi.useFakeTimers({ toFake: FAKE_TIMERS });
  const target = channel(CHANNEL);

  binding?.onEvent?.({ chatId: CHANNEL, kind: "run_started", runId: "r1" });
  binding?.onEvent?.({
    chatId: CHANNEL,
    delta: "Hel",
    kind: "text_delta",
    runId: "r1",
  });
  await vi.advanceTimersByTimeAsync(0);

  expect(target.typing).toBe(1);
  expect(target.sent.map((message) => message.payload.content)).toStrictEqual([
    "Hel",
  ]);

  binding?.onEvent?.({
    chatId: CHANNEL,
    delta: "lo",
    kind: "text_delta",
    runId: "r1",
  });
  binding?.onEvent?.({
    chatId: CHANNEL,
    delta: " world",
    kind: "text_delta",
    runId: "r1",
  });
  await vi.advanceTimersByTimeAsync(1100);

  const [draft] = target.sent;

  expect(draft?.edits).toStrictEqual([]);

  await vi.advanceTimersByTimeAsync(100);

  expect(draft?.edits.map((edit) => edit.content)).toStrictEqual([
    "Hello world",
  ]);

  await binding?.deliver({
    chatId: CHANNEL,
    kind: "message",
    messageId: "m1",
    runId: "r1",
    source: "reply",
    text: "Hello world, final.",
  });

  expect(target.sent).toHaveLength(1);
  expect(draft?.payload.content).toBe("Hello world, final.");
});

it("shows only typing in typing mode and sends the final reply as a new message", async () => {
  await startBinding({ ...baseConfig, streaming: "typing" });
  vi.useFakeTimers({ toFake: FAKE_TIMERS });
  const target = channel(DM);

  binding?.onEvent?.({ chatId: DM, kind: "run_started", runId: "r2" });
  binding?.onEvent?.({
    chatId: DM,
    delta: "draft",
    kind: "text_delta",
    runId: "r2",
  });
  await vi.advanceTimersByTimeAsync(8000);

  expect(target.sent).toStrictEqual([]);
  expect(target.typing).toBe(2);

  binding?.onEvent?.({
    chatId: DM,
    kind: "run_finished",
    runId: "r2",
    status: "completed",
  });
  await vi.advanceTimersByTimeAsync(16_000);

  expect(target.typing).toBe(2);

  await binding?.deliver({
    chatId: DM,
    kind: "message",
    messageId: "m2",
    runId: "r2",
    source: "reply",
    text: "done",
  });

  expect(target.sent.map((message) => message.payload.content)).toStrictEqual([
    "done",
  ]);
});

it("splits long replies into 2000-character messages and drops duplicate deliveries", async () => {
  await startBinding();

  const text = Array.from({ length: 90 }, () => "word ".repeat(10).trim()).join(
    "\n\n"
  );

  const long: Delivery = {
    chatId: CHANNEL,
    kind: "message",
    messageId: "long",
    source: "reply",
    text,
  };

  await binding?.deliver(long);
  await binding?.deliver(long);

  const contents = channel(CHANNEL).sent.map(
    (message) => message.payload.content ?? ""
  );

  expect(contents.length).toBeGreaterThan(1);
  expect(contents.every((content) => content.length <= DISCORD_LIMIT)).toBe(
    true
  );
  expect(contents.join("\n\n")).toBe(text);
});

it("stages inbound attachments up to the limit and reports skipped files", async () => {
  fetchFile.mockImplementation(async (url) => {
    await Promise.resolve();
    const size = url === "https://cdn.example/big.bin" ? MAX_BYTES + 1 : 5;

    return new Response(new Uint8Array(size).fill(7));
  });
  const client = await startBinding();

  client.emitMessage(
    inbound(DM, {
      content: "files",
      files: [
        {
          contentType: "text/plain",
          id: "a1",
          name: "notes.txt",
          size: 5,
          url: "https://cdn.example/notes.txt",
        },
        {
          contentType: null,
          id: "a2",
          name: "huge.bin",
          size: MAX_BYTES + 1,
          url: "https://cdn.example/huge.bin",
        },
        {
          contentType: null,
          id: "a3",
          name: "big.bin",
          size: 10,
          url: "https://cdn.example/big.bin",
        },
      ],
    })
  );
  await vi.waitFor(() => {
    expect(sent).toHaveLength(1);
  });

  const [message] = sent;
  const [staged] = message?.attachments ?? [];
  const stagedPath = staged?.kind === "file" ? staged.path : "";

  expect(fetchFile).toHaveBeenCalledTimes(2);
  expect(message?.attachments).toHaveLength(1);
  expect(staged).toMatchObject({
    filename: "notes.txt",
    kind: "file",
    mimeType: "text/plain",
    sizeBytes: 5,
  });
  expect(path.dirname(stagedPath)).toBe(path.join(root, "staging"));
  await expect(readFile(stagedPath)).resolves.toStrictEqual(
    Buffer.from([7, 7, 7, 7, 7])
  );
  expect(message?.text).toContain("huge.bin was not received");
  expect(message?.text).toContain("big.bin was not received");
});

it("uploads outbound attachments and rejects files over the limit as permanent", async () => {
  await startBinding();

  await binding?.deliver({
    attachments: [
      {
        data: new Uint8Array([1, 2, 3]),
        filename: "a.bin",
        kind: "bytes",
        mimeType: "application/octet-stream",
      },
    ],
    chatId: CHANNEL,
    kind: "message",
    messageId: "files",
    source: "reply",
    text: "here",
  });

  const [message] = channel(CHANNEL).sent;

  expect(message?.payload.content).toBe("here");
  expect(message?.payload.files).toStrictEqual([
    { attachment: Buffer.from([1, 2, 3]), name: "a.bin" },
  ]);

  await expect(
    binding?.deliver({
      attachments: [
        {
          filename: "big.bin",
          kind: "file",
          mimeType: "application/octet-stream",
          path: "/nowhere/big.bin",
          sizeBytes: MAX_BYTES + 1,
        },
      ],
      chatId: CHANNEL,
      kind: "message",
      messageId: "too-big",
      source: "reply",
      text: "",
    })
  ).rejects.toMatchObject({ kind: "permanent", name: "DeliveryError" });
});

it("shows four Approval buttons and submits a press as a decision", async () => {
  const client = await startBinding();

  await binding?.deliver(approvalRequest("ap-1"));
  await binding?.deliver(approvalRequest("ap-1"));
  const target = channel(CHANNEL);
  const buttons = buttonsOf(target.sent[0]);

  expect(target.sent).toHaveLength(1);
  expect(target.sent[0]?.payload.content).toContain("`shell`");
  expect(
    buttons.map((button) => [button.label, button.disabled])
  ).toStrictEqual([
    ["Allow once", false],
    ["Allow in Conversation", false],
    ["Always allow", false],
    ["Deny", false],
  ]);

  const press = buttonPress(CHANNEL, buttons[1]?.customId ?? "");
  client.emitInteraction(press);
  await settle();

  expect(decisions).toStrictEqual([
    {
      approvalId: "ap-1",
      chatId: CHANNEL,
      resolution: { decision: "allow_conversation", resolvedBy: "Ada" },
    },
  ]);

  const [update] = press.editReply.mock.calls[0] ?? [];

  expect(update?.content).toContain("Allowed for this Conversation** by Ada");
  expect(
    update?.components?.[0]?.components.map((button) => button.disabled)
  ).toStrictEqual([true, true, true, true]);
});

it("tells the Sender when a pressed Approval already ended", async () => {
  const client = await startBinding();
  decisionWins = false;

  await binding?.deliver(approvalRequest("ap-2"));
  const [deny] = buttonsOf(channel(CHANNEL).sent[0]).slice(-1);
  const press = buttonPress(CHANNEL, deny?.customId ?? "");
  client.emitInteraction(press);
  await settle();

  expect(
    decisions.map((decision) => decision.resolution.decision)
  ).toStrictEqual(["deny"]);
  expect(press.editReply).not.toHaveBeenCalled();
  expect(press.followUp).toHaveBeenCalledWith({
    content: "This Approval already ended.",
    flags: MessageFlags.Ephemeral,
  });
});

it("ignores Approval presses from a Chat that is not allowed", async () => {
  const client = await startBinding();

  await binding?.deliver(approvalRequest("ap-3"));
  const [first] = buttonsOf(channel(CHANNEL).sent[0]);
  const press = buttonPress(OTHER_CHANNEL, first?.customId ?? "");
  client.emitInteraction(press);
  await settle();

  expect(decisions).toStrictEqual([]);
  expect(press.deferUpdate).not.toHaveBeenCalled();
});

it("disables the buttons on approval_resolved, also after a restart", async () => {
  await startBinding();
  await binding?.deliver(approvalRequest("ap-4"));
  await binding?.stop();

  await startBinding();
  await binding?.deliver({
    approvalId: "ap-4",
    chatId: CHANNEL,
    decision: "timeout",
    kind: "approval_resolved",
    messageId: "resolved-4",
  });

  const [prompt] = channel(CHANNEL).sent;

  expect(prompt?.payload.content).toContain("**Timed out**");
  expect(buttonsOf(prompt).map((button) => button.disabled)).toStrictEqual([
    true,
    true,
    true,
    true,
  ]);
});

it("maps Discord failures to permanent and retryable delivery errors", async () => {
  const unstarted = await createBinding();

  await expect(
    unstarted.deliver(reply("early", CHANNEL))
  ).rejects.toMatchObject({ kind: "retryable" });

  await startBinding();

  await expect(binding?.deliver(reply("gone", "999"))).rejects.toMatchObject({
    kind: "permanent",
  });
  await expect(
    binding?.deliver(reply("unlisted", OTHER_CHANNEL))
  ).rejects.toMatchObject({ kind: "permanent" });

  channel(CHANNEL).failure = apiError(50_013, 403);

  await expect(
    binding?.deliver(reply("denied", CHANNEL))
  ).rejects.toMatchObject({ kind: "permanent" });

  channel(CHANNEL).failure = apiError(0, 502);

  await expect(binding?.deliver(reply("flaky", CHANNEL))).rejects.toMatchObject(
    { kind: "retryable" }
  );
});
