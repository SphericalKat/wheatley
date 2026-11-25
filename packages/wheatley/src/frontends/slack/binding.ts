import { DISPLAY_NAME_MAX_LENGTH, isJsonValue } from "@wheatley-ai/protocol";
import type {
  Attachment,
  Delivery,
  FrontendBinding,
  FrontendContext,
  FrontendSink,
  RunEvent,
  WebhookRequest,
  WebhookResponse,
  WebhookRoute,
  WebhookRouteHandler,
} from "@wheatley-ai/sdk";
import { DeliveryError, parseCommandText } from "@wheatley-ai/sdk";

import { stageInboundFile } from "./attachments.js";
import type { FetchFunction } from "./attachments.js";
import { BackgroundTasks } from "./background-tasks.js";
import { dropOldest } from "./bounded.js";
import { isChatAllowed, toChatId } from "./chat-id.js";
import type { SlackBindingConfig } from "./config.js";
import { toDeliveryError } from "./delivery-errors.js";
import {
  parseEventCallback,
  parseInteraction,
  parseSlashCommand,
} from "./inbound.js";
import type {
  SlackApprovalAction,
  SlackMessage,
  SlackSlashCommand,
} from "./inbound.js";
import { LiveProgress } from "./live-progress.js";
import type { PostedMessage } from "./live-progress.js";
import { WEBHOOK_PATH_SUFFIX } from "./manifest.js";
import { SlackOutbound } from "./outbound.js";
import {
  decodeOptional,
  parseJsonText,
  UrlVerificationSchema,
} from "./schemas.js";
import { verifySlackSignature } from "./signature.js";
import type {
  SlackSdk,
  SlackSocketClient,
  SlackSocketEnvelope,
  SlackWebClient,
} from "./slack-client.js";
import { SlackStateStore } from "./state-store.js";

/** The number of Events API event IDs that the binding remembers to drop retried events. */
const MAX_SEEN_EVENTS = 1000;

/** The number of Chats whose latest Sender message the binding remembers for the typing reaction. */
const MAX_TRACKED_CHATS = 1000;

/** The number of Slack user display names that the binding caches. */
const MAX_CACHED_NAMES = 1000;

const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;

/** The third-party boundaries of the binding. */
export interface SlackBindingDeps {
  readonly loadSdk: () => Promise<SlackSdk>;
  readonly fetch: FetchFunction;
  /** Epoch milliseconds, for webhook signature timestamps. */
  readonly now: () => number;
}

/** What a started binding holds. */
interface Connection {
  readonly sink: FrontendSink;
  readonly web: SlackWebClient;
  readonly botUserId: string;
  readonly store: SlackStateStore;
  readonly live: LiveProgress;
  readonly outbound: SlackOutbound;
}

/** Adds `key` as the newest entry and drops the oldest entries above `max`. */
const remember = <K, V>(
  map: Map<K, V>,
  key: K,
  value: V,
  max: number
): void => {
  map.delete(key);
  map.set(key, value);
  dropOldest(map, max);
};

const plainResponse = (status: number, body?: string): WebhookResponse =>
  body === undefined
    ? { status }
    : { body, headers: { "content-type": "text/plain" }, status };

/** Removes the bot mention and decodes the three HTML entities that Slack uses in message text. */
const cleanText = (text: string, mention: string): string =>
  text
    .replaceAll(mention, "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .trim();

/** Reads the display name from a `users.info` response: the profile display name first, the user name last. */
const nameOf = async (
  web: SlackWebClient,
  user: string
): Promise<string | undefined> => {
  const info = await web.users.info({ user });

  return [
    info.user?.profile?.display_name,
    info.user?.profile?.real_name,
    info.user?.real_name,
    info.user?.name,
  ].find((candidate) => candidate !== undefined && candidate !== "");
};

/**
 * One running Slack Frontend Binding (ADR 0007, ADR 0012).
 *
 * Inbound: Socket Mode envelopes or signed Events API requests become `sink.send`, `sink.command`, and `sink.decide`
 * calls for allowed Chats. The binding acknowledges each envelope or request before it processes it, so Slack does not
 * retry while attachments download. `stop` waits for inbound work in progress.
 *
 * Outbound: `deliver` posts Markdown chunks, uploads attachments, and posts and updates Block Kit Approval prompts.
 */
export class SlackBinding implements FrontendBinding {
  readonly #config: SlackBindingConfig;
  readonly #ctx: FrontendContext;
  readonly #deps: SlackBindingDeps;
  readonly #seenEvents = new Map<string, true>();
  readonly #lastInbound = new Map<string, PostedMessage>();
  readonly #displayNames = new Map<string, string>();
  readonly #inboundTasks = new BackgroundTasks();
  #connection: Connection | undefined;
  #socket: SlackSocketClient | undefined;
  #route: WebhookRoute | undefined;
  #stopped = false;

  /** Throws if the config uses `webhook` transport while the Webhook Ingress is disabled. */
  constructor(
    config: SlackBindingConfig,
    ctx: FrontendContext,
    deps: SlackBindingDeps
  ) {
    if (
      config.transport === "webhook" &&
      ctx.registerWebhookRoute === undefined
    ) {
      throw new Error(
        "Slack webhook transport needs the Webhook Ingress: set webhooks.enabled to true in config.yaml"
      );
    }

    this.#config = config;
    this.#ctx = ctx;
    this.#deps = deps;
  }

  /**
   * Loads the Slack packages, checks the bot token with `auth.test`, then opens the Socket Mode connection or mounts
   * the webhook route. Rejects if the token is invalid or Socket Mode cannot connect.
   */
  readonly start = async (sink: FrontendSink): Promise<void> => {
    const sdk = await this.#deps.loadSdk();
    const web = sdk.createWebClient(this.#config.botToken, this.#ctx.log);
    const { user_id: botUserId } = await web.auth.test();

    if (botUserId === undefined) {
      throw new Error("Slack auth.test returned no bot user ID");
    }

    const store = await SlackStateStore.load(this.#ctx.dataDir, this.#ctx.log);

    const live = new LiveProgress({
      client: web,
      editIntervalMs: this.#config.editIntervalMs,
      lastInbound: (chatId) => this.#lastInbound.get(chatId),
      log: this.#ctx.log,
      streaming: this.#config.streaming,
      typingReaction: this.#config.typingReaction,
    });

    const outbound = new SlackOutbound({
      live,
      maxAttachmentBytes: this.#ctx.maxAttachmentBytes,
      store,
      web,
    });

    this.#connection = { botUserId, live, outbound, sink, store, web };

    if (this.#config.transport === "socket") {
      await this.#startSocket(sdk);
    } else {
      this.#route = this.#ctx.registerWebhookRoute?.(
        WEBHOOK_PATH_SUFFIX,
        this.#handleWebhook
      );
    }

    this.#ctx.log.info("Slack binding started", {
      botUserId,
      transport: this.#config.transport,
    });
  };

  readonly deliver = async (delivery: Delivery): Promise<void> => {
    const connection = this.#connection;

    if (connection === undefined || this.#stopped) {
      throw new DeliveryError("The Slack binding is not running", {
        kind: "retryable",
      });
    }

    try {
      await connection.outbound.deliver(delivery);
    } catch (error) {
      throw toDeliveryError(error);
    }
  };

  readonly onEvent = (event: RunEvent): void => {
    if (!this.#stopped) {
      this.#connection?.live.onEvent(event);
    }
  };

  readonly stop = async (): Promise<void> => {
    this.#stopped = true;
    this.#route?.unregister();

    try {
      await this.#socket?.disconnect();
    } catch (error) {
      this.#ctx.log.warn("Slack Socket Mode disconnect failed", {
        error: String(error),
      });
    }

    await this.#inboundTasks.settled();
    await this.#connection?.live.stop();
    await this.#connection?.store.flush();
  };

  readonly #startSocket = async (sdk: SlackSdk): Promise<void> => {
    const { appToken } = this.#config;

    if (appToken === undefined) {
      throw new Error("Slack socket transport needs appToken");
    }

    const socket = sdk.createSocketClient(appToken, this.#ctx.log);

    this.#socket = socket;
    socket.on("slack_event", (envelope) => {
      this.#runInBackground(this.#handleEnvelope(envelope));
    });
    await socket.start();
  };

  /** Runs inbound work in the background and logs its failure. `stop` waits for it. */
  readonly #runInBackground = (task: Promise<void>): void => {
    this.#inboundTasks.add(this.#logInboundFailure(task));
  };

  readonly #logInboundFailure = async (task: Promise<void>): Promise<void> => {
    try {
      await task;
    } catch (error) {
      this.#ctx.log.error("Slack inbound handling failed", {
        error: String(error),
      });
    }
  };

  readonly #handleEnvelope = async (
    envelope: SlackSocketEnvelope
  ): Promise<void> => {
    await envelope.ack();

    const body = isJsonValue(envelope.body) ? envelope.body : undefined;

    switch (envelope.type) {
      case "events_api": {
        await this.#handleMessage(parseEventCallback(body));
        break;
      }

      case "slash_commands": {
        await this.#handleCommand(parseSlashCommand(body));
        break;
      }

      case "interactive": {
        await this.#handleAction(parseInteraction(body));
        break;
      }

      default: {
        break;
      }
    }
  };

  /** Verifies and acknowledges one Events API, Slash Command, or interactivity request (ADR 0012). */
  readonly #handleWebhook: WebhookRouteHandler = async (request) =>
    await Promise.resolve(this.#routeWebhook(request));

  readonly #routeWebhook = (request: WebhookRequest): WebhookResponse => {
    const secret = this.#config.signingSecret ?? "";

    if (!verifySlackSignature(request, secret, this.#deps.now())) {
      this.#ctx.log.warn(
        "Rejected a Slack webhook request with a bad signature"
      );

      return plainResponse(HTTP_UNAUTHORIZED);
    }

    const text = Buffer.from(request.body).toString("utf-8");
    const contentType = request.headers["content-type"] ?? "";

    if (contentType.includes("application/json")) {
      return this.#routeJson(parseJsonText(text));
    }

    const form = new URLSearchParams(text);
    const interaction = form.get("payload");

    if (interaction === null) {
      this.#runInBackground(
        this.#handleCommand(parseSlashCommand(Object.fromEntries(form)))
      );
    } else {
      this.#runInBackground(
        this.#handleAction(parseInteraction(parseJsonText(interaction)))
      );
    }

    return plainResponse(HTTP_OK);
  };

  readonly #routeJson = (
    payload: ReturnType<typeof parseJsonText>
  ): WebhookResponse => {
    const verification = decodeOptional(UrlVerificationSchema, payload);

    if (verification !== undefined) {
      return plainResponse(HTTP_OK, verification.challenge);
    }

    if (payload === undefined) {
      return plainResponse(HTTP_BAD_REQUEST);
    }

    this.#runInBackground(this.#handleMessage(parseEventCallback(payload)));

    return plainResponse(HTTP_OK);
  };

  /** Returns false and logs the Chat ID at `info` level if `allowedChatIds` does not list the Chat (ADR 0012). */
  readonly #allowed = (chatId: string): boolean => {
    if (isChatAllowed(this.#config.allowedChatIds, chatId)) {
      return true;
    }

    this.#ctx.log.info("Dropped Slack input from a Chat that is not allowed", {
      chatId,
    });

    return false;
  };

  /** Returns false for a duplicate of an event that the binding already handled. */
  readonly #firstSeen = (message: SlackMessage): boolean => {
    const key = message.eventId ?? `${message.channel}:${message.ts}`;

    if (this.#seenEvents.has(key)) {
      return false;
    }

    remember(this.#seenEvents, key, true, MAX_SEEN_EVENTS);

    return true;
  };

  /** DMs always start a Run. In channels, the default needs a bot mention or a reply in a thread of the bot. */
  readonly #isAddressed = (
    connection: Connection,
    message: SlackMessage,
    chatId: string,
    mentioned: boolean
  ): boolean => {
    const isOpen =
      message.channelType === "im" ||
      this.#config.channelTrigger === "all" ||
      mentioned;

    const isReply =
      message.threadTs !== undefined &&
      (message.parentUserId === connection.botUserId ||
        connection.store.isEngaged(chatId));

    return isOpen || isReply;
  };

  readonly #handleMessage = async (
    message: SlackMessage | undefined
  ): Promise<void> => {
    const connection = this.#connection;

    if (connection === undefined || message === undefined) {
      return;
    }

    const isOwnMessage = message.user === connection.botUserId;

    if (isOwnMessage || !this.#firstSeen(message)) {
      return;
    }

    const chatId = toChatId(message.channel, message.threadTs);
    const mention = `<@${connection.botUserId}>`;
    const mentioned = message.text.includes(mention);

    if (
      !this.#allowed(chatId) ||
      !this.#isAddressed(connection, message, chatId, mentioned)
    ) {
      return;
    }

    if (message.threadTs !== undefined) {
      await connection.store.engage(chatId);
    }

    remember(
      this.#lastInbound,
      chatId,
      { channel: message.channel, ts: message.ts },
      MAX_TRACKED_CHATS
    );

    const text = cleanText(message.text, mention);

    const senderDisplayName = await this.#displayName(connection, message.user);

    // Slash Command payloads carry no thread, so a thread Chat takes a command as a mention: `@bot /stop`.
    const isThreadCommand =
      message.threadTs !== undefined && mentioned && message.files.length === 0;

    const command = isThreadCommand ? parseCommandText(text) : undefined;

    if (command !== undefined) {
      await connection.sink.command({
        args: command.args,
        chatId,
        name: command.name,
        senderDisplayName,
      });

      return;
    }

    const { attachments, notes } = await this.#stageFiles(message);

    const fullText = [text, ...notes]
      .filter((part) => part !== "")
      .join("\n\n");

    if (fullText === "" && attachments.length === 0) {
      return;
    }

    await connection.sink.send({
      attachments: attachments.length === 0 ? undefined : attachments,
      chatId,
      senderDisplayName,
      text: fullText,
    });
  };

  /** Downloads the files of a message. A skipped file becomes a note in the message text, so the Agent knows. */
  readonly #stageFiles = async (
    message: SlackMessage
  ): Promise<{
    readonly attachments: Attachment[];
    readonly notes: string[];
  }> => {
    const attachments: Attachment[] = [];
    const notes: string[] = [];

    for (const file of message.files) {
      // oxlint-disable-next-line no-await-in-loop -- Sequential downloads hold at most one file in memory.
      const result = await stageInboundFile(file, {
        botToken: this.#config.botToken,
        fetch: this.#deps.fetch,
        maxBytes: this.#ctx.maxAttachmentBytes,
        stagingDir: this.#ctx.stagingDir,
      });

      if (result.ok) {
        attachments.push(result.attachment);
      } else {
        this.#ctx.log.warn("Skipped a Slack file", {
          fileId: file.id,
          reason: result.reason,
        });
        notes.push(
          result.reason === "too_large"
            ? `[Attachment ${file.name} was not received: it is larger than ${this.#ctx.maxAttachmentBytes} bytes.]`
            : `[Attachment ${file.name} was not received: the download failed.]`
        );
      }
    }

    return { attachments, notes };
  };

  readonly #handleCommand = async (
    command: SlackSlashCommand | undefined
  ): Promise<void> => {
    const connection = this.#connection;

    if (connection === undefined || command === undefined) {
      return;
    }

    const chatId = toChatId(command.channel);

    if (!this.#allowed(chatId)) {
      return;
    }

    const parsed = parseCommandText(`${command.command} ${command.text}`);

    if (parsed === undefined) {
      this.#ctx.log.debug("Ignored an unknown Slack Slash Command", {
        command: command.command,
      });

      return;
    }

    await connection.sink.command({
      args: parsed.args,
      chatId,
      name: parsed.name,
      senderDisplayName: await this.#displayName(
        connection,
        command.user,
        command.userName
      ),
    });
  };

  readonly #handleAction = async (
    action: SlackApprovalAction | undefined
  ): Promise<void> => {
    const connection = this.#connection;

    if (connection === undefined || action === undefined) {
      return;
    }

    const chatId =
      connection.store.approval(action.approvalId)?.chatId ??
      toChatId(action.channel, action.threadTs);

    if (!this.#allowed(chatId)) {
      return;
    }

    const resolvedBy = await this.#displayName(
      connection,
      action.user,
      action.userName
    );

    const won = await connection.sink.decide({
      approvalId: action.approvalId,
      chatId,
      resolution: { decision: action.decision, resolvedBy },
    });

    if (!won) {
      this.#ctx.log.debug("A Slack Approval decision came too late", {
        approvalId: action.approvalId,
      });
    }
  };

  /** Looks up and caches the display name of a Slack user. Falls back to `fallback` or the user ID. */
  readonly #displayName = async (
    connection: Connection,
    user: string,
    fallback?: string
  ): Promise<string> => {
    const cached = this.#displayNames.get(user);

    if (cached !== undefined) {
      return cached;
    }

    try {
      const name = await nameOf(connection.web, user);

      if (name !== undefined) {
        const trimmed = name.slice(0, DISPLAY_NAME_MAX_LENGTH);

        remember(this.#displayNames, user, trimmed, MAX_CACHED_NAMES);

        return trimmed;
      }
    } catch (error) {
      this.#ctx.log.debug("Could not look up a Slack user", {
        error: String(error),
        user,
      });
    }

    return (fallback ?? user).slice(0, DISPLAY_NAME_MAX_LENGTH);
  };
}
