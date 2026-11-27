import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { WebAPIPlatformError, WebAPIRateLimitedError } from "@slack/web-api";
import type {
  ChatPostMessageArguments,
  ChatUpdateArguments,
} from "@slack/web-api";
import type {
  Delivery,
  FrontendBinding,
  FrontendContext,
  JsonObject,
  MessageDelivery,
} from "@wheatley-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InMemorySecretStore } from "../../contracts/secret-store.fake.js";
import { InMemoryWebhookIngress } from "../../contracts/webhook-ingress.fake.js";
import type { FetchFunction } from "./attachments.js";
import { RecordingLogger } from "./recording-logger.fake.js";
import { RecordingSink } from "./recording-sink.fake.js";
import { createSlackFrontend } from "./slack-frontend.js";
import { FakeSlackSocketClient, fakeSlackSdk } from "./slack-socket.fake.js";
import { FakeSlackWebClient } from "./slack-web.fake.js";

const BOT = "UBOT";
const AGENT = "home";
const BINDING_ID = "slack-main";
const SIGNING_SECRET = "signing-secret";
const MIB = 1_048_576;
const MAX_MARKDOWN = 12_000;
const SECONDS = 1000;

/** The `ts` that `FakeSlackWebClient` returns for its first posted message. */
const FIRST_TS = "1000.000001";

const secrets = new InMemorySecretStore({
  SLACK_APP: "xapp-1",
  SLACK_BOT: "xoxb-1",
  SLACK_SIGNING: SIGNING_SECRET,
});

const BASE_CONFIG: JsonObject = {
  allowedChatIds: ["C1", "D1"],
  appToken: { secret: "SLACK_APP" },
  botToken: { secret: "SLACK_BOT" },
};

interface HarnessOptions {
  readonly config?: JsonObject;
  readonly maxAttachmentBytes?: number;
  readonly fetch?: FetchFunction;
  readonly ingress?: InMemoryWebhookIngress;
  readonly dataDir?: string;
  readonly now?: () => number;
}

interface Harness {
  readonly web: FakeSlackWebClient;
  readonly socket: FakeSlackSocketClient;
  readonly sink: RecordingSink;
  readonly log: RecordingLogger;
  readonly binding: FrontendBinding;
  readonly ctx: FrontendContext;
}

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  vi.useRealTimers();

  for (const cleanup of cleanups.splice(0).toReversed()) {
    // oxlint-disable-next-line no-await-in-loop -- Bindings stop before their directories go.
    await cleanup();
  }
});

const tempDir = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), "wheatley-slack-"));

  cleanups.push(async () => {
    await rm(dir, { force: true, recursive: true });
  });

  return dir;
};

const createContext = async (
  log: RecordingLogger,
  options: HarnessOptions
): Promise<FrontendContext> => {
  const { ingress } = options;

  const base = {
    agentName: AGENT,
    bindingId: BINDING_ID,
    dataDir: options.dataDir ?? (await tempDir()),
    log,
    maxAttachmentBytes: options.maxAttachmentBytes ?? 10 * MIB,
    secrets,
    stagingDir: await tempDir(),
  };

  return ingress === undefined
    ? base
    : {
        ...base,
        registerWebhookRoute: (suffix, handler) =>
          ingress.registerFrontendRoute(AGENT, BINDING_ID, suffix, handler),
      };
};

const unusedFetch: FetchFunction = async () => {
  await Promise.resolve();

  throw new Error("Unexpected download");
};

const setup = async (options: HarnessOptions = {}): Promise<Harness> => {
  const web = new FakeSlackWebClient(BOT, { U1: "Alice" });
  const socket = new FakeSlackSocketClient();
  const sink = new RecordingSink();
  const log = new RecordingLogger();
  const ctx = await createContext(log, options);

  const frontend = createSlackFrontend({
    fetch: options.fetch ?? unusedFetch,
    loadSdk: fakeSlackSdk(web, socket),
    now: options.now ?? Date.now,
  });

  const binding = await frontend.createBinding(
    { ...BASE_CONFIG, ...options.config },
    ctx
  );

  await binding.start(sink);
  cleanups.push(async () => {
    await binding.stop();
  });

  return { binding, ctx, log, sink, socket, web };
};

let eventCounter = 0;

/** An Events API `message` event. Each call gets a new `event_id` and `ts`. */
const messageEvent = (event: JsonObject): JsonObject => {
  eventCounter += 1;

  return {
    event: {
      channel_type: "channel",
      text: "",
      ts: `1700.${String(eventCounter).padStart(6, "0")}`,
      type: "message",
      user: "U1",
      ...event,
    },
    event_id: `Ev${eventCounter}`,
    type: "event_callback",
  };
};

const dm = (text: string, extra: JsonObject = {}): JsonObject =>
  messageEvent({ channel: "D1", channel_type: "im", text, ...extra });

const message = (fields: Partial<MessageDelivery>): MessageDelivery => ({
  chatId: "C1",
  kind: "message",
  messageId: "m-1",
  source: "reply",
  text: "Hello",
  ...fields,
});

const threadOf = (args: ChatPostMessageArguments): string | undefined =>
  "thread_ts" in args ? args.thread_ts : undefined;

const markdownOf = (
  args: ChatPostMessageArguments | ChatUpdateArguments
): string => ("markdown_text" in args ? args.markdown_text : "");

/** The `action_id` and `value` of each button in the actions block of a posted message. */
const buttonsOf = (
  args: ChatPostMessageArguments | undefined
): {
  readonly actionId: string | undefined;
  readonly value: string | undefined;
}[] => {
  const blocks = args !== undefined && "blocks" in args ? args.blocks : [];
  const actions = blocks.find((block) => block.type === "actions");

  if (actions === undefined || !("elements" in actions)) {
    return [];
  }

  return actions.elements.map((element) => ({
    actionId: "action_id" in element ? element.action_id : undefined,
    value: "value" in element ? element.value : undefined,
  }));
};

const otherPrompt: Delivery = {
  approvalId: "ap-0",
  chatId: "C1",
  expiresAt: "2026-11-26T10:00:00Z",
  inputPreview: "{}",
  kind: "approval_requested",
  messageId: "m-ap-0",
  runId: "r0",
  toolName: "shell",
};

const startRun = async (config: JsonObject = {}): Promise<Harness> => {
  const harness = await setup({ config });

  harness.socket.emit("events_api", dm("question"));
  await vi.waitFor(() => {
    expect(harness.sink.messages).toHaveLength(1);
  });
  vi.useFakeTimers();
  harness.binding.onEvent?.({
    chatId: "D1",
    kind: "run_started",
    runId: "r1",
  });
  await vi.advanceTimersByTimeAsync(0);

  return harness;
};

const delta = (harness: Harness, text: string): void => {
  harness.binding.onEvent?.({
    chatId: "D1",
    delta: text,
    kind: "text_delta",
    runId: "r1",
  });
};

const fileEvent = (file: JsonObject): JsonObject =>
  dm("see file", {
    files: [
      {
        id: "F1",
        mimetype: "text/plain",
        name: "notes.txt",
        url_private_download: "https://files.slack.test/F1",
        ...file,
      },
    ],
    subtype: "file_share",
  });

const requested: Delivery = {
  approvalId: "ap-1",
  chatId: "C1:1699.000006",
  expiresAt: null,
  inputPreview: '{"command":"rm -rf <tmp>"}',
  kind: "approval_requested",
  messageId: "m-ap-1",
  runId: "r1",
  toolName: "shell",
};

const resolved: Delivery = {
  approvalId: "ap-1",
  chatId: "C1:1699.000006",
  decision: "allow_conversation",
  kind: "approval_resolved",
  messageId: "m-ap-2",
  resolvedBy: "Alice",
};

const click = (decision: string, channel = "C1"): JsonObject => ({
  actions: [{ action_id: `wheatley_approval:${decision}`, value: "ap-1" }],
  channel: { id: channel },
  message: { thread_ts: "1699.000006", ts: FIRST_TS },
  type: "block_actions",
  user: { id: "U1", username: "alice" },
});

const ROUTE = `/frontends/${AGENT}/${BINDING_ID}/events`;

const webhookSetup = async (
  now = Date.now
): Promise<Harness & { readonly ingress: InMemoryWebhookIngress }> => {
  const ingress = new InMemoryWebhookIngress({
    agent: () => ({ state: () => "running", triggers: () => {} }),
    secrets,
  });

  const harness = await setup({
    config: {
      signingSecret: { secret: "SLACK_SIGNING" },
      transport: "webhook",
    },
    ingress,
    now,
  });

  return { ...harness, ingress };
};

const signedRequest = (
  body: string,
  contentType: string,
  options: { readonly timestamp?: number; readonly secret?: string } = {}
) => {
  const timestamp = String(
    Math.floor((options.timestamp ?? Date.now()) / SECONDS)
  );

  const signature = `v0=${createHmac("sha256", options.secret ?? SIGNING_SECRET)
    .update(`v0:${timestamp}:${body}`)
    .digest("hex")}`;

  return {
    body: new TextEncoder().encode(body),
    headers: {
      "content-type": contentType,
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
    },
    method: "POST",
    path: ROUTE,
    query: {},
  };
};

describe("Slack Frontend config", () => {
  it("rejects an empty allowedChatIds list", async () => {
    const log = new RecordingLogger();
    const ctx = await createContext(log, {});
    const frontend = createSlackFrontend({ fetch: unusedFetch });

    await expect(async () => {
      await frontend.createBinding({ ...BASE_CONFIG, allowedChatIds: [] }, ctx);
    }).rejects.toThrow(/allowedChatIds/u);
  });

  it("rejects a secret name that has no value", async () => {
    const ctx = await createContext(new RecordingLogger(), {});
    const frontend = createSlackFrontend();

    await expect(async () => {
      await frontend.createBinding(
        { ...BASE_CONFIG, botToken: { secret: "MISSING" } },
        ctx
      );
    }).rejects.toThrow(/MISSING/u);
  });

  it("rejects socket transport without an app token", async () => {
    const ctx = await createContext(new RecordingLogger(), {});
    const { appToken: _appToken, ...withoutAppToken } = BASE_CONFIG;

    await expect(async () => {
      await createSlackFrontend().createBinding(withoutAppToken, ctx);
    }).rejects.toThrow(/appToken/u);
  });

  it("rejects webhook transport while the Webhook Ingress is disabled", async () => {
    const ctx = await createContext(new RecordingLogger(), {});

    await expect(async () => {
      await createSlackFrontend().createBinding(
        {
          ...BASE_CONFIG,
          signingSecret: { secret: "SLACK_SIGNING" },
          transport: "webhook",
        },
        ctx
      );
    }).rejects.toThrow(/Webhook Ingress/u);
  });
});

describe("Slack inbound messages", () => {
  it("forwards an allowed DM with the Sender display name and acknowledges the envelope", async () => {
    const { sink, socket } = await setup();

    socket.emit("events_api", dm("hi &amp; bye"));

    await vi.waitFor(() => {
      expect(sink.messages).toEqual([
        { chatId: "D1", senderDisplayName: "Alice", text: "hi & bye" },
      ]);
    });
    expect(socket.acks).toBe(1);
  });

  it("drops a Chat that allowedChatIds does not list and logs its ID", async () => {
    const { binding, log, sink, socket } = await setup();

    socket.emit(
      "events_api",
      messageEvent({ channel: "C9", text: `<@${BOT}> hi` })
    );
    await binding.stop();

    expect(sink.messages).toEqual([]);
    expect(log.records).toContainEqual({
      fields: { chatId: "C9" },
      level: "info",
      message: "Dropped Slack input from a Chat that is not allowed",
    });
  });

  it("maps a thread to its own Chat and allows it through the parent channel", async () => {
    const { sink, socket } = await setup();

    socket.emit(
      "events_api",
      messageEvent({
        channel: "C1",
        text: `<@${BOT}> in a thread`,
        thread_ts: "1699.000001",
      })
    );
    socket.emit(
      "events_api",
      messageEvent({ channel: "C1", text: `<@${BOT}> top level` })
    );

    await vi.waitFor(() => {
      expect(sink.messages).toHaveLength(2);
    });
    expect(sink.messages.map(({ chatId, text }) => ({ chatId, text }))).toEqual(
      expect.arrayContaining([
        { chatId: "C1:1699.000001", text: "in a thread" },
        { chatId: "C1", text: "top level" },
      ])
    );
  });

  it("allows a thread that allowedChatIds lists without its channel", async () => {
    const { sink, socket } = await setup({
      config: { allowedChatIds: ["C2:1699.000001"] },
    });

    socket.emit(
      "events_api",
      messageEvent({
        channel: "C2",
        text: `<@${BOT}> yes`,
        thread_ts: "1699.000001",
      })
    );

    await vi.waitFor(() => {
      expect(sink.messages.map((entry) => entry.chatId)).toEqual([
        "C2:1699.000001",
      ]);
    });
  });

  it("needs a mention or a reply in a channel by default", async () => {
    const { binding, sink, socket } = await setup();

    socket.emit("events_api", messageEvent({ channel: "C1", text: "chatter" }));
    socket.emit(
      "events_api",
      messageEvent({
        channel: "C1",
        text: "other thread",
        thread_ts: "1699.000009",
      })
    );
    socket.emit(
      "events_api",
      messageEvent({
        channel: "C1",
        parent_user_id: BOT,
        text: "reply to the bot",
        thread_ts: "1699.000002",
      })
    );
    await binding.stop();

    expect(sink.messages.map((entry) => entry.text)).toEqual([
      "reply to the bot",
    ]);
  });

  it("accepts replies without a mention in a thread where the bot posted", async () => {
    const { binding, sink, socket } = await setup();

    await binding.deliver(
      message({ chatId: "C1:1699.000003", text: "I am here" })
    );
    socket.emit(
      "events_api",
      messageEvent({ channel: "C1", text: "thanks", thread_ts: "1699.000003" })
    );

    await vi.waitFor(() => {
      expect(sink.messages.map((entry) => entry.chatId)).toEqual([
        "C1:1699.000003",
      ]);
    });
  });

  it("accepts every channel message with channelTrigger all", async () => {
    const { sink, socket } = await setup({ config: { channelTrigger: "all" } });

    socket.emit("events_api", messageEvent({ channel: "C1", text: "chatter" }));

    await vi.waitFor(() => {
      expect(sink.messages.map((entry) => entry.text)).toEqual(["chatter"]);
    });
  });

  it("ignores bot messages, its own messages, edits, and retried events", async () => {
    const { binding, sink, socket } = await setup();
    const event = dm("once");

    socket.emit("events_api", event);
    socket.emit("events_api", event);
    socket.emit("events_api", dm("from a bot", { bot_id: "B1" }));
    socket.emit("events_api", dm("from itself", { user: BOT }));
    socket.emit("events_api", dm("edited", { subtype: "message_changed" }));
    await binding.stop();

    expect(sink.messages.map((entry) => entry.text)).toEqual(["once"]);
    expect(socket.acks).toBe(5);
  });

  it("turns a mention with command text in a thread into a typed command for the thread Chat", async () => {
    const { sink, socket } = await setup();

    socket.emit(
      "events_api",
      messageEvent({
        channel: "C1",
        text: `<@${BOT}> /model  claude-x `,
        thread_ts: "1699.000004",
      })
    );

    await vi.waitFor(() => {
      expect(sink.commandCalls).toEqual([
        {
          args: "claude-x",
          chatId: "C1:1699.000004",
          name: "model",
          senderDisplayName: "Alice",
        },
      ]);
    });
    expect(sink.messages).toEqual([]);
  });

  it("sends command text outside a thread as a normal message", async () => {
    const { sink, socket } = await setup();

    socket.emit("events_api", dm("/model claude-x"));

    await vi.waitFor(() => {
      expect(sink.messages.map((entry) => entry.text)).toEqual([
        "/model claude-x",
      ]);
    });
    expect(sink.commandCalls).toEqual([]);
  });
});

describe("Slack Slash Commands", () => {
  it("maps a native Slash Command to sink.command for the channel Chat", async () => {
    const { sink, socket } = await setup();

    socket.emit("slash_commands", {
      channel_id: "C1",
      command: "/goal",
      text: "ship v1",
      user_id: "U1",
      user_name: "alice",
    });

    await vi.waitFor(() => {
      expect(sink.commandCalls).toEqual([
        {
          args: "ship v1",
          chatId: "C1",
          name: "goal",
          senderDisplayName: "Alice",
        },
      ]);
    });
  });

  it("ignores unknown commands and commands from Chats that are not allowed", async () => {
    const { binding, sink, socket } = await setup();

    socket.emit("slash_commands", {
      channel_id: "C1",
      command: "/deploy",
      text: "",
      user_id: "U1",
    });
    socket.emit("slash_commands", {
      channel_id: "C9",
      command: "/new",
      text: "",
      user_id: "U1",
    });
    await binding.stop();

    expect(sink.commandCalls).toEqual([]);
  });
});

describe("Slack live progress", () => {
  it("shows a typing reaction on the Sender message for the length of the Run", async () => {
    const harness = await startRun();
    const [received] = harness.web.reactionsAdded();

    expect(received).toMatchObject({
      channel: "D1",
      name: "hourglass_flowing_sand",
    });

    harness.binding.onEvent?.({
      chatId: "D1",
      kind: "run_finished",
      runId: "r1",
      status: "completed",
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.web.reactionsRemoved()).toEqual([
      {
        channel: "D1",
        name: "hourglass_flowing_sand",
        timestamp: received?.timestamp,
      },
    ]);
  });

  it("edits the draft at most once per interval and replaces it with the final message", async () => {
    const harness = await startRun();

    delta(harness, "Hel");
    await vi.advanceTimersByTimeAsync(0);
    delta(harness, "lo");
    await vi.advanceTimersByTimeAsync(500);
    delta(harness, " world");
    await vi.advanceTimersByTimeAsync(600);

    expect(harness.web.posts().map(markdownOf)).toEqual(["Hel"]);
    expect(harness.web.updates()).toEqual([]);

    await vi.advanceTimersByTimeAsync(100);

    expect(harness.web.updates().map(markdownOf)).toEqual(["Hello world"]);

    harness.binding.onEvent?.({
      chatId: "D1",
      kind: "run_finished",
      runId: "r1",
      status: "completed",
    });
    await harness.binding.deliver(
      message({ chatId: "D1", runId: "r1", text: "Hello world!" })
    );

    expect(harness.web.posts()).toHaveLength(1);
    expect(harness.web.updates()).toEqual([
      { channel: "D1", markdown_text: "Hello world", ts: FIRST_TS },
      { channel: "D1", markdown_text: "Hello world!", ts: FIRST_TS },
    ]);
  });

  it("shows only the typing reaction in typing mode", async () => {
    const harness = await startRun({ streaming: "typing" });

    delta(harness, "Hello");
    await vi.advanceTimersByTimeAsync(5000);
    await harness.binding.deliver(
      message({ chatId: "D1", runId: "r1", text: "Hello" })
    );

    expect(harness.web.updates()).toEqual([]);
    expect(harness.web.posts().map(markdownOf)).toEqual(["Hello"]);
    expect(harness.web.reactionsAdded()).toHaveLength(1);
  });
});

describe("Slack outbound messages", () => {
  it("posts a thread reply into its thread", async () => {
    const { binding, web } = await setup();

    await binding.deliver(
      message({ chatId: "C1:1699.000004", text: "**done**" })
    );

    const [posted] = web.posts();

    expect(posted).toEqual({
      channel: "C1",
      markdown_text: "**done**",
      thread_ts: "1699.000004",
    });
  });

  it("splits long text into chunks and drops a repeated messageId", async () => {
    const { binding, web } = await setup();
    const long = `${"a".repeat(MAX_MARKDOWN)}\n\n${"b".repeat(10)}`;

    await binding.deliver(message({ text: long }));
    await binding.deliver(message({ text: long }));

    expect(web.posts().map(markdownOf)).toEqual([
      "a".repeat(MAX_MARKDOWN),
      "b".repeat(10),
    ]);
  });

  it("resumes a retried delivery after the last chunk that Slack confirmed", async () => {
    const { binding, web } = await setup();
    const long = `${"a".repeat(MAX_MARKDOWN)}\n\n${"b".repeat(10)}`;

    web.failNext("chat.postMessage", new WebAPIRateLimitedError(30), 1);

    await expect(
      binding.deliver(message({ text: long }))
    ).rejects.toMatchObject({
      kind: "retryable",
      retryAfterMs: 30 * SECONDS,
    });

    await binding.deliver(message({ text: long }));

    expect(web.posts().map((args) => markdownOf(args).charAt(0))).toEqual([
      "a",
      "b",
    ]);
  });

  it("rejects permanently when the Chat is gone", async () => {
    const { binding, web } = await setup();

    web.failNext(
      "chat.postMessage",
      new WebAPIPlatformError({ error: "channel_not_found", ok: false })
    );

    await expect(binding.deliver(message({}))).rejects.toMatchObject({
      kind: "permanent",
      name: "DeliveryError",
    });
  });

  it("rejects as retryable before start and after stop", async () => {
    const { binding } = await setup();

    await binding.stop();

    await expect(binding.deliver(message({}))).rejects.toMatchObject({
      kind: "retryable",
    });
  });
});

describe("Slack attachments", () => {
  it("stages an inbound file with the bot token and forwards it", async () => {
    const requests: { url: string; authorization: string | undefined }[] = [];

    const fetch: FetchFunction = async (url, init) => {
      await Promise.resolve();
      requests.push({ authorization: init.headers.authorization, url });

      return new Response("hello");
    };

    const { ctx, sink, socket } = await setup({ fetch });

    socket.emit("events_api", fileEvent({ size: 5 }));

    await vi.waitFor(() => {
      expect(sink.messages).toHaveLength(1);
    });

    const [attachment] = sink.messages[0]?.attachments ?? [];

    expect(requests).toEqual([
      { authorization: "Bearer xoxb-1", url: "https://files.slack.test/F1" },
    ]);
    expect(attachment).toMatchObject({
      filename: "notes.txt",
      kind: "file",
      mimeType: "text/plain",
      sizeBytes: 5,
    });
    expect(attachment?.kind === "file" && path.dirname(attachment.path)).toBe(
      ctx.stagingDir
    );
    expect(
      attachment?.kind === "file" && (await readFile(attachment.path, "utf-8"))
    ).toBe("hello");
  });

  it("skips an inbound file that is larger than the limit and tells the Agent", async () => {
    let downloads = 0;

    const fetch: FetchFunction = async () => {
      await Promise.resolve();
      downloads += 1;

      return new Response(new Uint8Array(2048));
    };

    const { sink, socket } = await setup({ fetch, maxAttachmentBytes: 1024 });

    socket.emit("events_api", fileEvent({ size: 4096 }));
    socket.emit("events_api", fileEvent({ id: "F2", name: "big.bin" }));

    await vi.waitFor(() => {
      expect(sink.messages).toHaveLength(2);
    });

    expect(downloads).toBe(1);
    expect(sink.messages.map((entry) => entry.attachments)).toEqual([
      undefined,
      undefined,
    ]);
    expect(sink.messages.map((entry) => entry.text)).toEqual(
      expect.arrayContaining([
        "see file\n\n[Attachment notes.txt was not received: it is larger than 1024 bytes.]",
        "see file\n\n[Attachment big.bin was not received: it is larger than 1024 bytes.]",
      ])
    );
  });

  it("uploads outbound attachments into the thread after the text", async () => {
    const { binding, web } = await setup();
    const data = new TextEncoder().encode("report");

    await binding.deliver(
      message({
        attachments: [
          {
            data,
            filename: "report.txt",
            kind: "bytes",
            mimeType: "text/plain",
          },
        ],
        chatId: "C1:1699.000005",
        text: "Here",
      })
    );

    expect(web.calls.map((call) => call.method)).toEqual([
      "chat.postMessage",
      "filesUploadV2",
    ]);
    expect(web.uploads()).toEqual([
      {
        channel_id: "C1",
        file: Buffer.from(data),
        filename: "report.txt",
        thread_ts: "1699.000005",
        title: "report.txt",
      },
    ]);
  });

  it("rejects an oversized outbound attachment permanently before it posts anything", async () => {
    const { binding, web } = await setup({ maxAttachmentBytes: 1024 });

    await expect(
      binding.deliver(
        message({
          attachments: [
            {
              data: new Uint8Array(2048),
              filename: "big.bin",
              kind: "bytes",
              mimeType: "application/octet-stream",
            },
          ],
        })
      )
    ).rejects.toMatchObject({ kind: "permanent" });
    expect(web.calls).toEqual([]);
  });
});

describe("Slack Approvals", () => {
  it("posts a Block Kit prompt with four decision buttons once per Approval", async () => {
    const { binding, web } = await setup();

    await binding.deliver(requested);
    await binding.deliver(requested);

    const posts = web.posts();
    const [prompt] = posts;

    expect(posts).toHaveLength(1);
    expect(prompt && threadOf(prompt)).toBe("1699.000006");
    expect(JSON.stringify(prompt)).toContain("rm -rf &lt;tmp&gt;");
    expect(buttonsOf(prompt)).toEqual(
      ["allow_once", "allow_conversation", "allow_always", "deny"].map(
        (decision) => ({
          actionId: `wheatley_approval:${decision}`,
          value: "ap-1",
        })
      )
    );
  });

  it("submits a button click as a decision from the originating Chat", async () => {
    const { binding, sink, socket } = await setup();

    await binding.deliver(requested);
    socket.emit("interactive", click("allow_conversation"));

    await vi.waitFor(() => {
      expect(sink.decisions).toEqual([
        {
          approvalId: "ap-1",
          chatId: "C1:1699.000006",
          resolution: { decision: "allow_conversation", resolvedBy: "Alice" },
        },
      ]);
    });
  });

  it("ignores clicks from a Chat that is not allowed", async () => {
    const { binding, sink, socket } = await setup();

    socket.emit("interactive", click("deny", "C9"));
    await binding.stop();

    expect(sink.decisions).toEqual([]);
  });

  it("updates the prompt without buttons when the Approval ends, also after a restart", async () => {
    const dataDir = await tempDir();
    const first = await setup({ dataDir });

    await first.binding.deliver(requested);
    await first.binding.stop();

    const second = await setup({ dataDir });

    await second.binding.deliver(resolved);
    await second.binding.deliver(resolved);

    const [prompt] = first.web.posts();
    const updates = second.web.updates();
    const [update] = updates;

    expect(updates).toHaveLength(1);
    expect(update?.ts).toBe(FIRST_TS);
    expect(prompt?.channel).toBe("C1");
    expect(JSON.stringify(update)).toContain("Allowed for this Conversation");
    expect(JSON.stringify(update)).not.toContain('"type":"actions"');
  });

  it("posts the outcome as a new message if it has no record of the prompt", async () => {
    const { binding, web } = await setup();

    await binding.deliver({
      ...resolved,
      approvalId: "ap-unknown",
      decision: "timeout",
      reason: "no answer <!channel>",
    });

    const [post] = web.posts();

    expect(web.updates()).toEqual([]);
    expect(post !== undefined && "text" in post ? post.text : "").toBe(
      ":hourglass: Approval ap-unknown: Timed out by Alice. Reason: no answer &lt;!channel&gt;"
    );
  });
});

/** One `static_select` menu of a posted model picker. */
interface PickerSelect {
  readonly actionId: string;
  readonly placeholder: string;
  readonly initialValue: string | undefined;
  readonly values: readonly string[];
  readonly texts: readonly string[];
}

/** The model select menus of a posted message, one array per `actions` block. */
const selectsOf = (
  args: ChatPostMessageArguments | undefined
): PickerSelect[][] => {
  const blocks = args !== undefined && "blocks" in args ? args.blocks : [];

  return blocks.flatMap((block) =>
    block.type === "actions" && "elements" in block
      ? [
          block.elements.flatMap((element) =>
            element.type === "static_select"
              ? [
                  {
                    actionId: element.action_id ?? "",
                    initialValue: element.initial_option?.value,
                    placeholder: element.placeholder?.text ?? "",
                    texts: (element.options ?? []).map(
                      (option) => option.text.text
                    ),
                    values: (element.options ?? []).map(
                      (option) => option.value ?? ""
                    ),
                  },
                ]
              : []
          ),
        ]
      : []
  );
};

const model = (provider: string, id: string, name = id) => ({
  id,
  name,
  provider,
});

const pickerMessage = (
  models: readonly ReturnType<typeof model>[],
  fields: Partial<MessageDelivery> = {}
): MessageDelivery =>
  message({
    chatId: "C1:1699.000006",
    messageId: "m-picker",
    modelPicker: {
      current: { id: "gpt-5", provider: "openai" },
      models,
    },
    text: "Available models: ...",
    ...fields,
  });

const selection = (value: string, channel = "C1"): JsonObject => ({
  actions: [
    {
      action_id: "wheatley_model:0:0",
      selected_option: { text: { text: value, type: "plain_text" }, value },
      type: "static_select",
    },
  ],
  channel: { id: channel },
  message: { thread_ts: "1699.000006", ts: FIRST_TS },
  type: "block_actions",
  user: { id: "U1", username: "alice" },
});

describe("Slack model picker", () => {
  it("posts one select menu per provider with the current model selected, once per messageId", async () => {
    const { binding, web } = await setup();

    const delivery = pickerMessage([
      model("anthropic", "claude-x", "Claude X"),
      model("openai", "gpt-5", "GPT-5"),
      model("openai", "o9"),
    ]);

    await binding.deliver(delivery);
    await binding.deliver(delivery);

    const posts = web.posts();
    const [picker] = posts;

    expect(posts).toHaveLength(1);
    expect(picker && threadOf(picker)).toBe("1699.000006");
    expect(picker && markdownOf(picker)).toBe("");
    expect(JSON.stringify(picker)).toContain("Current model: `openai/gpt-5`");
    expect(selectsOf(picker)).toEqual([
      [
        {
          actionId: "wheatley_model:0:0",
          initialValue: undefined,
          placeholder: "anthropic",
          texts: ["Claude X"],
          values: ["anthropic/claude-x"],
        },
      ],
      [
        {
          actionId: "wheatley_model:1:0",
          initialValue: "openai/gpt-5",
          placeholder: "openai",
          texts: ["GPT-5", "o9"],
          values: ["openai/gpt-5", "openai/o9"],
        },
      ],
    ]);
  });

  it("posts the text when no model is available", async () => {
    const { binding, web } = await setup();

    await binding.deliver(
      pickerMessage([], { text: "No models are available." })
    );

    expect(web.posts().map(markdownOf)).toEqual(["No models are available."]);
  });

  it("splits a provider into menus of 100, truncates long names, and skips values over 150 characters", async () => {
    const { binding, web } = await setup();

    const many = Array.from({ length: 150 }, (_, index) =>
      model("openrouter", `vendor/model-${String(index).padStart(3, "0")}`)
    );

    await binding.deliver(
      pickerMessage([
        model("anthropic", "long", "😀".repeat(50)),
        model("anthropic", "x".repeat(150)),
        ...many,
      ])
    );

    const [picker] = web.posts();
    const [anthropic, openrouter] = selectsOf(picker);
    const [longName] = anthropic?.[0]?.texts ?? [];

    expect(anthropic?.map((select) => select.values)).toEqual([
      ["anthropic/long"],
    ]);
    expect(longName?.length).toBeLessThanOrEqual(75);
    expect(longName?.endsWith("😀…")).toBe(true);
    expect(
      openrouter?.map((select) => [select.placeholder, select.values.length])
    ).toEqual([
      ["openrouter (1/2)", 100],
      ["openrouter (2/2)", 50],
    ]);
    expect(JSON.stringify(picker)).toContain(
      "1 model has an ID too long for this menu."
    );
  });

  it("posts the text when the picker needs more than 50 blocks", async () => {
    const { binding, web } = await setup();

    const models = Array.from({ length: 50 }, (_, index) =>
      model(`provider-${String(index).padStart(2, "0")}`, "m")
    );

    await binding.deliver(pickerMessage(models));

    const [posted] = web.posts();

    expect(posted && markdownOf(posted)).toBe("Available models: ...");
    expect(selectsOf(posted)).toEqual([]);
  });

  it("runs /model for the thread Chat of the picker and replaces the menus with the selection", async () => {
    const { binding, sink, socket, web } = await setup();

    await binding.deliver(pickerMessage([model("openai", "gpt-5")]));
    socket.emit("interactive", selection("openrouter/vendor/model-a"));

    await vi.waitFor(() => {
      expect(web.updates()).toHaveLength(1);
    });

    const [update] = web.updates();

    expect(sink.commandCalls).toEqual([
      {
        args: "openrouter/vendor/model-a",
        chatId: "C1:1699.000006",
        name: "model",
        senderDisplayName: "Alice",
      },
    ]);
    expect(update?.ts).toBe(FIRST_TS);
    expect(update?.channel).toBe("C1");
    expect(JSON.stringify(update)).toContain(
      "*Model selected:* `openrouter/vendor/model-a` by Alice"
    );
    expect(JSON.stringify(update)).not.toContain("static_select");
  });

  it("ignores a selection from a Chat that is not allowed", async () => {
    const { binding, sink, socket, web } = await setup();

    socket.emit("interactive", selection("openai/gpt-5", "C9"));
    await binding.stop();

    expect(sink.commandCalls).toEqual([]);
    expect(web.updates()).toEqual([]);
  });

  it("runs a signed webhook selection and rejects an unsigned one", async () => {
    const { binding, ingress, sink } = await webhookSetup();
    const form = "application/x-www-form-urlencoded";

    const body = new URLSearchParams({
      payload: JSON.stringify(selection("openai/gpt-5")),
    }).toString();

    const unsigned = await ingress.handle(
      signedRequest(body, form, { secret: "other" })
    );

    const signed = await ingress.handle(signedRequest(body, form));

    await vi.waitFor(() => {
      expect(sink.commandCalls).toHaveLength(1);
    });
    await binding.stop();

    expect([unsigned.status, signed.status]).toEqual([401, 200]);
    expect(sink.commandCalls.map((call) => call.args)).toEqual([
      "openai/gpt-5",
    ]);
  });
});

describe("Slack Events API webhook", () => {
  it("does not open Socket Mode", async () => {
    const { socket } = await webhookSetup();

    expect(socket.started).toBe(false);
  });

  it("answers the URL verification challenge", async () => {
    const { ingress } = await webhookSetup();

    const response = await ingress.handle(
      signedRequest(
        JSON.stringify({ challenge: "abc", type: "url_verification" }),
        "application/json"
      )
    );

    expect(response).toMatchObject({ body: "abc", status: 200 });
  });

  it("rejects a wrong signature or a stale timestamp with 401", async () => {
    const { binding, ingress, sink } = await webhookSetup();
    const body = JSON.stringify(dm("hi"));

    const wrong = await ingress.handle(
      signedRequest(body, "application/json", { secret: "other" })
    );

    const stale = await ingress.handle(
      signedRequest(body, "application/json", {
        timestamp: Date.now() - 301 * SECONDS,
      })
    );

    await binding.stop();

    expect([wrong.status, stale.status]).toEqual([401, 401]);
    expect(sink.messages).toEqual([]);
  });

  it("forwards a signed message event", async () => {
    const { ingress, sink } = await webhookSetup();

    const response = await ingress.handle(
      signedRequest(JSON.stringify(dm("hello")), "application/json")
    );

    expect(response.status).toBe(200);
    await vi.waitFor(() => {
      expect(sink.messages.map((entry) => entry.text)).toEqual(["hello"]);
    });
  });

  it("handles signed Slash Command and interactivity forms", async () => {
    const { binding, ingress, sink } = await webhookSetup();

    await binding.deliver(otherPrompt);

    const command = new URLSearchParams({
      channel_id: "C1",
      command: "/model",
      text: "x-1",
      user_id: "U1",
    });

    const interaction = new URLSearchParams({
      payload: JSON.stringify({
        actions: [{ action_id: "wheatley_approval:deny", value: "ap-9" }],
        channel: { id: "C1" },
        type: "block_actions",
        user: { id: "U1" },
      }),
    });

    const form = "application/x-www-form-urlencoded";

    const responses = await Promise.all([
      ingress.handle(signedRequest(command.toString(), form)),
      ingress.handle(signedRequest(interaction.toString(), form)),
    ]);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    await vi.waitFor(() => {
      expect(sink.commandCalls).toEqual([
        {
          args: "x-1",
          chatId: "C1",
          name: "model",
          senderDisplayName: "Alice",
        },
      ]);
      expect(sink.decisions).toEqual([
        {
          approvalId: "ap-9",
          chatId: "C1",
          resolution: { decision: "deny", resolvedBy: "Alice" },
        },
      ]);
    });
  });

  it("unmounts the route on stop", async () => {
    const { binding, ingress } = await webhookSetup();

    await binding.stop();

    const response = await ingress.handle(
      signedRequest(JSON.stringify(dm("late")), "application/json")
    );

    expect(response.status).toBe(404);
  });
});
