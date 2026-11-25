import { randomBytes, timingSafeEqual } from "node:crypto";

import { DISPLAY_NAME_MAX_LENGTH } from "@wheatley/protocol";
import {
  chunkMarkdown,
  DeliveryError,
  isDeliveryError,
  parseCommandText,
} from "@wheatley/sdk";
import type {
  ApprovalRequestedDelivery,
  ApprovalResolvedDelivery,
  Delivery,
  FrontendBinding,
  FrontendContext,
  FrontendSink,
  MessageDelivery,
  RunEvent,
  WebhookRequest,
  WebhookResponse,
  WebhookRoute,
} from "@wheatley/sdk";
import { Value } from "typebox/value";

import {
  ApprovalPromptStore,
  approvalKeyboard,
  approvalRequestText,
  approvalResolvedText,
  parseApprovalCallback,
} from "./approvals.js";
import type { StagedFiles } from "./attachments.js";
import {
  attachmentSize,
  incomingFiles,
  stageIncomingFiles,
  toUpload,
} from "./attachments.js";
import { chatKeyOf, createAllowlist, parseChatKey } from "./chat-key.js";
import type { TelegramTarget } from "./chat-key.js";
import { TelegramApiError, TelegramUpdateSchema } from "./client.js";
import type {
  BotIdentity,
  TelegramCallbackQuery,
  TelegramClient,
  TelegramEntity,
  TelegramMessage,
  TelegramUpdate,
  TelegramUser,
  TextOptions,
} from "./client.js";
import type { TelegramConfig } from "./config.js";
import { LiveRuns } from "./live.js";
import type { Draft } from "./live.js";
import { markdownToTelegramHtml } from "./markdown.js";

/** The path suffix of the webhook route: `/frontends/<agent>/<binding-id>/updates`. */
export const WEBHOOK_PATH_SUFFIX = "updates";

/** The header that carries the secret token of `setWebhook`. */
export const SECRET_TOKEN_HEADER = "x-telegram-bot-api-secret-token";

/** Chunks stay below the 4096-character message limit of the Bot API. */
const MAX_CHUNK_LENGTH = 4000;

const MS_PER_SECOND = 1000;
const BYTES_PER_MIB = 1_048_576;

/** How many delivered message IDs and webhook update IDs a binding remembers to drop duplicates. */
const DEDUP_CAPACITY = 1000;

const HTTP_BAD_REQUEST = 400;
const HTTP_FORBIDDEN = 403;
const HTTP_TOO_MANY_REQUESTS = 429;

const SECRET_TOKEN_BYTES = 32;

const PARSE_ERROR = /can't parse entities/iu;
const NOT_MODIFIED = /message is not modified/iu;
const COMMAND_SUFFIX = /^\/[a-z]+@(?<bot>\w+)/iu;

const GROUP_TYPES = new Set(["group", "supergroup"]);

/** A set that forgets its oldest entries beyond `capacity`. */
class RecentSet<T> {
  readonly #items = new Set<T>();
  readonly #capacity: number;

  constructor(capacity: number) {
    this.#capacity = capacity;
  }

  readonly has = (item: T): boolean => this.#items.has(item);

  readonly add = (item: T): void => {
    this.#items.add(item);

    for (const oldest of this.#items) {
      if (this.#items.size <= this.#capacity) {
        break;
      }

      this.#items.delete(oldest);
    }
  };
}

/** Converts a client error to the `DeliveryError` that the outbox expects. */
const toDeliveryError = (cause: unknown): DeliveryError => {
  if (isDeliveryError(cause)) {
    return cause;
  }

  if (!(cause instanceof TelegramApiError)) {
    const message = cause instanceof Error ? cause.message : String(cause);

    return new DeliveryError(message, { cause, kind: "retryable" });
  }

  const error = cause;

  if (error.code === HTTP_TOO_MANY_REQUESTS) {
    return new DeliveryError(error.message, {
      cause: error,
      kind: "retryable",
      retryAfterMs:
        error.retryAfterSeconds === undefined
          ? undefined
          : error.retryAfterSeconds * MS_PER_SECOND,
    });
  }

  // 400 means a deleted Chat, a deleted topic, or a request that Telegram never accepts. 403 means a removed bot.
  const isPermanent =
    error.code === HTTP_BAD_REQUEST || error.code === HTTP_FORBIDDEN;

  return new DeliveryError(error.message, {
    cause: error,
    kind: isPermanent ? "permanent" : "retryable",
  });
};

const isApiError = (cause: unknown, pattern: RegExp): boolean =>
  cause instanceof TelegramApiError &&
  cause.code === HTTP_BAD_REQUEST &&
  pattern.test(cause.message);

const displayName = (user: TelegramUser | undefined): string | undefined => {
  if (user === undefined) {
    return undefined;
  }

  const fullName = [user.first_name, user.last_name ?? ""].join(" ").trim();
  const name = fullName === "" ? user.username : fullName;

  return name?.slice(0, DISPLAY_NAME_MAX_LENGTH);
};

const tokensMatch = (given: string, expected: string): boolean => {
  const left = Buffer.from(given);
  const right = Buffer.from(expected);

  return left.length === right.length && timingSafeEqual(left, right);
};

const entityText = (text: string, entity: TelegramEntity): string =>
  text.slice(entity.offset, entity.offset + entity.length);

/** Returns true if a group message mentions the bot, runs its command, or replies to it. */
const isAddressedToBot = (
  message: TelegramMessage,
  text: string,
  entities: readonly TelegramEntity[],
  me: BotIdentity
): boolean => {
  const mention = `@${me.username}`.toLowerCase();

  const mentioned = entities.some((entity) => {
    const value = entityText(text, entity).toLowerCase();

    return (
      (entity.type === "mention" && value === mention) ||
      (entity.type === "bot_command" && value.endsWith(mention)) ||
      (entity.type === "text_mention" && entity.user?.id === me.id)
    );
  });

  const reply = message.reply_to_message;

  // In a forum topic, Telegram sets `reply_to_message` to the topic's first message on every message.
  const isTopicRoot =
    message.is_topic_message === true &&
    reply?.message_id === message.message_thread_id;

  const repliesToBot = !isTopicRoot && reply?.from?.id === me.id;

  return mentioned || repliesToBot;
};

/** Removes `@<bot>` mentions from message text. */
const stripMention = (text: string, me: BotIdentity): string =>
  text
    .replaceAll(new RegExp(`@${me.username}\\b`, "giu"), "")
    .replaceAll(/[ \t]{2,}/gu, " ")
    .trim();

/** Returns true if the text is a command for another bot, for example `/new@other_bot`. */
const isCommandForOtherBot = (text: string, me: BotIdentity): boolean => {
  const commandBot = COMMAND_SUFFIX.exec(text.trim())?.groups?.bot;

  return (
    commandBot !== undefined &&
    commandBot.toLowerCase() !== me.username.toLowerCase()
  );
};

/** Progress of one `message` delivery, so a retry resumes after the parts that Telegram already confirmed. */
interface MessageProgress {
  sentParts: number;
  draft: Draft | undefined;
}

/** What the binding needs besides its config and context. */
export interface TelegramBindingDeps {
  readonly client: TelegramClient;
}

/**
 * Creates one Telegram Frontend Binding (ADRs 0007 and 0012).
 *
 * Throws if webhook mode is configured while the Webhook Ingress is disabled.
 */
export const createTelegramBinding = (
  config: TelegramConfig,
  ctx: FrontendContext,
  deps: TelegramBindingDeps
): FrontendBinding => {
  const { client } = deps;
  const { log } = ctx;
  const { registerWebhookRoute } = ctx;

  if (
    config.transport.mode === "webhook" &&
    registerWebhookRoute === undefined
  ) {
    throw new Error(
      `Telegram binding ${ctx.bindingId} uses webhook mode, but the Webhook Ingress is disabled`
    );
  }

  const isAllowed = createAllowlist(config.allowedChatIds);
  const approvals = new ApprovalPromptStore(ctx.dataDir);

  const live = new LiveRuns(client, log, {
    draftIntervalMs: config.draftIntervalMs,
    streaming: config.streaming,
  });

  const progress = new Map<string, MessageProgress>();
  const delivered = new RecentSet<string>(DEDUP_CAPACITY);
  const seenUpdates = new RecentSet<number>(DEDUP_CAPACITY);
  const secretToken = randomBytes(SECRET_TOKEN_BYTES).toString("base64url");

  let sink: FrontendSink | undefined;
  let bot: BotIdentity | undefined;
  let polling: Promise<void> | undefined;
  let route: WebhookRoute | undefined;
  let webhookQueue: Promise<void> = Promise.resolve();

  const sendFormatted = async (
    target: TelegramTarget,
    markdown: string,
    options: Omit<TextOptions, "parseMode"> = {}
  ): Promise<number> => {
    try {
      return await client.sendMessage(
        target.chatId,
        target.threadId,
        markdownToTelegramHtml(markdown),
        { ...options, parseMode: "HTML" }
      );
    } catch (error) {
      if (!isApiError(error, PARSE_ERROR)) {
        throw error;
      }

      return await client.sendMessage(
        target.chatId,
        target.threadId,
        markdown,
        options
      );
    }
  };

  /** Edits a message. Resolves `false` if Telegram cannot edit it any more, for example because it was deleted. */
  const editFormatted = async (
    chatId: number,
    messageId: number,
    html: string,
    plain: string,
    options: Omit<TextOptions, "parseMode"> = {}
  ): Promise<boolean> => {
    try {
      await client.editMessageText(chatId, messageId, html, {
        ...options,
        parseMode: "HTML",
      });

      return true;
    } catch (error) {
      if (isApiError(error, NOT_MODIFIED)) {
        return true;
      }

      if (!isApiError(error, PARSE_ERROR)) {
        if (
          error instanceof TelegramApiError &&
          error.code === HTTP_BAD_REQUEST
        ) {
          return false;
        }

        throw error;
      }
    }

    await client.editMessageText(chatId, messageId, plain, options);

    return true;
  };

  /** Sends one chunk of a reply, into the Run's draft message if there is one that Telegram can still edit. */
  const sendChunk = async (
    target: TelegramTarget,
    chunk: string,
    draft: Draft | undefined
  ): Promise<void> => {
    const edited =
      draft !== undefined &&
      (await editFormatted(
        draft.target.chatId,
        draft.messageId,
        markdownToTelegramHtml(chunk),
        chunk
      ));

    if (!edited) {
      await sendFormatted(target, chunk);
    }
  };

  const deliverMessage = async (
    delivery: MessageDelivery,
    target: TelegramTarget
  ): Promise<void> => {
    const attachments = delivery.attachments ?? [];

    const oversized = attachments.find(
      (attachment) => attachmentSize(attachment) > ctx.maxAttachmentBytes
    );

    if (oversized !== undefined) {
      throw new DeliveryError(
        `Attachment ${oversized.filename} exceeds ${ctx.maxAttachmentBytes} bytes`,
        { kind: "permanent" }
      );
    }

    const chunks = chunkMarkdown(delivery.text, MAX_CHUNK_LENGTH).filter(
      (chunk) => chunk.trim() !== ""
    );

    let state = progress.get(delivery.messageId);

    if (state === undefined) {
      const draft =
        delivery.runId === undefined
          ? undefined
          : await live.takeDraft(delivery.runId);

      const sameChat =
        draft?.target.chatId === target.chatId &&
        draft.target.threadId === target.threadId;

      state = { draft: sameChat ? draft : undefined, sentParts: 0 };
      progress.set(delivery.messageId, state);
    }

    for (const [index, chunk] of chunks.entries()) {
      if (index < state.sentParts) {
        continue;
      }

      // oxlint-disable-next-line no-await-in-loop -- Chunks must arrive in order.
      await sendChunk(target, chunk, index === 0 ? state.draft : undefined);
      state.sentParts = index + 1;
    }

    for (const [index, attachment] of attachments.entries()) {
      if (chunks.length + index < state.sentParts) {
        continue;
      }

      const upload = toUpload(attachment);
      // oxlint-disable-next-line no-await-in-loop -- Attachments follow the text in order.
      await client.sendFile(
        target.chatId,
        target.threadId,
        upload.kind,
        upload.file
      );
      state.sentParts = chunks.length + index + 1;
    }

    progress.delete(delivery.messageId);
    delivered.add(delivery.messageId);
  };

  const deliverApprovalRequest = async (
    delivery: ApprovalRequestedDelivery,
    target: TelegramTarget
  ): Promise<void> => {
    if (approvals.get(delivery.approvalId) !== undefined) {
      return;
    }

    const messageId = await client.sendMessage(
      target.chatId,
      target.threadId,
      approvalRequestText(delivery),
      { keyboard: approvalKeyboard(delivery.approvalId), parseMode: "HTML" }
    );

    await approvals.put({
      approvalId: delivery.approvalId,
      chatId: delivery.chatId,
      inputPreview: delivery.inputPreview,
      messageId,
      telegramChatId: target.chatId,
      toolName: delivery.toolName,
    });
  };

  const deliverApprovalResolved = async (
    delivery: ApprovalResolvedDelivery,
    target: TelegramTarget
  ): Promise<void> => {
    const prompt = approvals.get(delivery.approvalId);
    const html = approvalResolvedText(delivery, prompt);

    const edited =
      prompt !== undefined &&
      (await editFormatted(
        prompt.telegramChatId,
        prompt.messageId,
        html,
        html,
        {
          keyboard: [],
        }
      ));

    if (!edited) {
      await client.sendMessage(target.chatId, target.threadId, html, {
        parseMode: "HTML",
      });
    }

    await approvals.delete(delivery.approvalId);
    delivered.add(delivery.messageId);
  };

  const deliver = async (delivery: Delivery): Promise<void> => {
    const target = parseChatKey(delivery.chatId);

    if (target === undefined) {
      throw new DeliveryError(`Invalid Telegram chat ID: ${delivery.chatId}`, {
        kind: "permanent",
      });
    }

    if (!isAllowed(delivery.chatId)) {
      throw new DeliveryError(
        `Telegram chat ${delivery.chatId} is not in allowedChatIds`,
        { kind: "permanent" }
      );
    }

    if (delivered.has(delivery.messageId)) {
      return;
    }

    try {
      switch (delivery.kind) {
        case "message": {
          await deliverMessage(delivery, target);
          break;
        }

        case "approval_requested": {
          await deliverApprovalRequest(delivery, target);
          break;
        }

        case "approval_resolved": {
          await deliverApprovalResolved(delivery, target);
          break;
        }

        default: {
          break;
        }
      }
    } catch (error) {
      throw toDeliveryError(error);
    }
  };

  /** Stages the files of a message and tells the Chat about files over the limit. */
  const stageFiles = async (message: TelegramMessage): Promise<StagedFiles> => {
    const staged = await stageIncomingFiles(
      client,
      incomingFiles(message),
      ctx.stagingDir,
      ctx.maxAttachmentBytes
    );

    if (staged.tooLarge.length > 0) {
      const bytes = ctx.maxAttachmentBytes;

      const limit =
        bytes >= BYTES_PER_MIB
          ? `${Math.floor(bytes / BYTES_PER_MIB)} MiB`
          : `${bytes} bytes`;

      await client.sendMessage(
        message.chat.id,
        message.is_topic_message === true
          ? message.message_thread_id
          : undefined,
        `Skipped ${staged.tooLarge.join(", ")}: files over ${limit} are not supported.`
      );
    }

    return staged;
  };

  const handleMessage = async (
    message: TelegramMessage,
    activeSink: FrontendSink,
    me: BotIdentity
  ): Promise<void> => {
    if (message.from?.is_bot === true) {
      return;
    }

    const chatId = chatKeyOf(message);

    if (!isAllowed(chatId)) {
      log.info(
        "Dropped a message from a Telegram chat that is not in allowedChatIds",
        {
          chatId,
        }
      );

      return;
    }

    const text = message.text ?? message.caption ?? "";
    const entities = message.entities ?? message.caption_entities ?? [];
    const senderDisplayName = displayName(message.from);
    const isGroup = GROUP_TYPES.has(message.chat.type);

    if (isCommandForOtherBot(text, me)) {
      return;
    }

    const command = parseCommandText(text);

    if (command !== undefined) {
      await activeSink.command({
        args: command.args,
        chatId,
        name: command.name,
        senderDisplayName,
      });

      return;
    }

    const needsMention = isGroup && config.groupActivation === "mention";

    if (needsMention && !isAddressedToBot(message, text, entities, me)) {
      return;
    }

    const staged = await stageFiles(message);
    const body = isGroup ? stripMention(text, me) : text.trim();

    if (body === "" && staged.attachments.length === 0) {
      return;
    }

    await activeSink.send({
      attachments:
        staged.attachments.length === 0 ? undefined : staged.attachments,
      chatId,
      senderDisplayName,
      text: body,
    });
  };

  const handleCallback = async (
    query: TelegramCallbackQuery,
    activeSink: FrontendSink
  ): Promise<void> => {
    const parsed = parseApprovalCallback(query.data ?? "");
    const { message } = query;
    const chatId = message === undefined ? undefined : chatKeyOf(message);

    if (chatId !== undefined && !isAllowed(chatId)) {
      log.info(
        "Dropped a button press from a Telegram chat that is not in allowedChatIds",
        {
          chatId,
        }
      );
      await client.answerCallbackQuery(query.id);

      return;
    }

    const prompt =
      parsed === undefined ? undefined : approvals.byToken(parsed.token);

    if (
      parsed === undefined ||
      prompt === undefined ||
      prompt.chatId !== chatId
    ) {
      await client.answerCallbackQuery(
        query.id,
        "This approval has already ended."
      );

      return;
    }

    const won = await activeSink.decide({
      approvalId: prompt.approvalId,
      chatId: prompt.chatId,
      resolution: {
        decision: parsed.decision,
        resolvedBy: displayName(query.from),
      },
    });

    await client.answerCallbackQuery(
      query.id,
      won ? "Decision recorded." : "This approval has already ended."
    );
  };

  /** Handles one update. Logs failures instead of throwing, so one bad update does not stop the others. */
  const handleUpdate = async (update: TelegramUpdate): Promise<void> => {
    if (sink === undefined || bot === undefined) {
      return;
    }

    try {
      if (update.message !== undefined) {
        await handleMessage(update.message, sink, bot);
      } else if (update.callback_query !== undefined) {
        await handleCallback(update.callback_query, sink);
      }
    } catch (error) {
      log.error("Failed to handle a Telegram update", {
        error: String(error),
        updateId: update.update_id,
      });
    }
  };

  const onWebhook = async (
    request: WebhookRequest
  ): Promise<WebhookResponse> => {
    const given = request.headers[SECRET_TOKEN_HEADER];

    if (given === undefined || !tokensMatch(given, secretToken)) {
      return { status: 401 };
    }

    let update: unknown;

    try {
      update = JSON.parse(Buffer.from(request.body).toString("utf-8"));
    } catch {
      return { status: 400 };
    }

    if (!Value.Check(TelegramUpdateSchema, update)) {
      return { status: 400 };
    }

    if (!seenUpdates.has(update.update_id)) {
      seenUpdates.add(update.update_id);

      const previous = webhookQueue;

      // `handleUpdate` never rejects, so the queue never rejects.
      const handled = (async (): Promise<void> => {
        await previous;
        await handleUpdate(update);
      })();

      webhookQueue = handled;
      await handled;
    }

    return { status: 200 };
  };

  return {
    deliver,
    onEvent: (event: RunEvent): void => {
      const target = parseChatKey(event.chatId);

      if (target !== undefined && isAllowed(event.chatId)) {
        live.onEvent(event, target);
      }
    },
    start: async (activeSink: FrontendSink): Promise<void> => {
      await approvals.load();
      bot = await client.getMe();
      sink = activeSink;

      try {
        await client.setMyCommands(
          activeSink.commands.map((command) => ({
            command: command.name,
            description:
              command.argument === undefined
                ? command.description
                : `${command.description} ${command.argument}`,
          }))
        );
      } catch (error) {
        log.warn("Failed to register Telegram bot commands", {
          error: String(error),
        });
      }

      if (
        config.transport.mode === "polling" ||
        registerWebhookRoute === undefined
      ) {
        polling = (async (): Promise<void> => {
          try {
            await client.startPolling(handleUpdate);
          } catch (error) {
            log.error("Telegram polling stopped", { error: String(error) });
          }
        })();

        return;
      }

      route = registerWebhookRoute(WEBHOOK_PATH_SUFFIX, onWebhook);
      await client.setWebhook(config.transport.url, secretToken);
      log.info("Telegram webhook registered", {
        route: route.path,
        url: config.transport.url,
      });
    },
    stop: async (): Promise<void> => {
      route?.unregister();
      route = undefined;
      live.stop();
      await client.stopPolling();
      await polling;
      await webhookQueue;
    },
  };
};
