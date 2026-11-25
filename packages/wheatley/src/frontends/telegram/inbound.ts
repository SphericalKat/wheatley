import { DISPLAY_NAME_MAX_LENGTH } from "@wheatley-ai/protocol";
import { parseCommandText } from "@wheatley-ai/sdk";
import type { FrontendContext, FrontendSink } from "@wheatley-ai/sdk";

import type { ApprovalPromptStore } from "./approvals.js";
import { parseApprovalCallback } from "./approvals.js";
import type { StagedFiles } from "./attachments.js";
import {
  incomingFiles,
  skippedFilesText,
  stageIncomingFiles,
} from "./attachments.js";
import { chatKeyOf, targetOf } from "./chat-key.js";
import type {
  BotIdentity,
  TelegramCallbackQuery,
  TelegramClient,
  TelegramEntity,
  TelegramMessage,
  TelegramUpdate,
  TelegramUser,
} from "./client.js";
import type { TelegramConfig } from "./config.js";

const COMMAND_SUFFIX = /^\/[a-z]+@(?<bot>\w+)/iu;

const GROUP_TYPES = new Set(["group", "supergroup"]);

const displayName = (user: TelegramUser | undefined): string | undefined => {
  if (user === undefined) {
    return undefined;
  }

  const fullName = [user.first_name, user.last_name ?? ""].join(" ").trim();
  const name = fullName === "" ? user.username : fullName;

  return name?.slice(0, DISPLAY_NAME_MAX_LENGTH);
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
  const mention =
    me.username === undefined ? undefined : `@${me.username}`.toLowerCase();

  const mentioned = entities.some((entity) => {
    const value = entityText(text, entity).toLowerCase();

    return (
      (mention !== undefined &&
        ((entity.type === "mention" && value === mention) ||
          (entity.type === "bot_command" && value.endsWith(mention)))) ||
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
  (me.username === undefined
    ? text
    : text.replaceAll(new RegExp(`@${me.username}\\b`, "giu"), "")
  )
    .replaceAll(/[ \t]{2,}/gu, " ")
    .trim();

/** Returns true if the text is a command for another bot, for example `/new@other_bot`. */
const isCommandForOtherBot = (text: string, me: BotIdentity): boolean => {
  const commandBot = COMMAND_SUFFIX.exec(text.trim())?.groups?.bot;

  return (
    commandBot !== undefined &&
    commandBot.toLowerCase() !== me.username?.toLowerCase()
  );
};

/** What the inbound side of a binding needs. */
export interface UpdateHandlerDeps {
  readonly client: TelegramClient;
  readonly config: Pick<TelegramConfig, "groupActivation">;
  readonly ctx: Pick<
    FrontendContext,
    "log" | "stagingDir" | "maxAttachmentBytes"
  >;
  readonly isAllowed: (chatKey: string) => boolean;
  readonly approvals: ApprovalPromptStore;
}

/** Handles one Telegram update for the bot `me` and passes its result to `sink`. Never rejects. */
export type UpdateHandler = (
  update: TelegramUpdate,
  sink: FrontendSink,
  me: BotIdentity
) => Promise<void>;

/**
 * Creates the inbound side of a Telegram binding: messages, commands, and Approval button presses.
 *
 * It drops updates from Chats outside `allowedChatIds` with an `info` log, and it logs any other failure at `error`
 * instead of rejecting, so one bad update does not stop the updates after it.
 */
export const createUpdateHandler = (deps: UpdateHandlerDeps): UpdateHandler => {
  const { approvals, client, config, ctx, isAllowed } = deps;
  const { log } = ctx;

  /** Stages the files of a message and tells the Chat about files over the limit. */
  const stageFiles = async (message: TelegramMessage): Promise<StagedFiles> => {
    const staged = await stageIncomingFiles(
      client,
      incomingFiles(message),
      ctx.stagingDir,
      ctx.maxAttachmentBytes
    );

    if (staged.tooLarge.length > 0) {
      await client.sendMessage(
        targetOf(message),
        skippedFilesText(staged.tooLarge, ctx.maxAttachmentBytes)
      );
    }

    return staged;
  };

  const handleMessage = async (
    message: TelegramMessage,
    sink: FrontendSink,
    me: BotIdentity
  ): Promise<void> => {
    if (message.from?.is_bot === true) {
      return;
    }

    const chatId = chatKeyOf(message);

    if (!isAllowed(chatId)) {
      log.info(
        "Dropped a message from a Telegram chat that is not in allowedChatIds",
        { chatId }
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

    // Commands skip mention gating: a command addresses bots by itself, and Telegram delivers bare commands to bots in
    // privacy mode. A command for another bot returned above.
    const command = parseCommandText(text);

    if (command !== undefined) {
      await sink.command({
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

    await sink.send({
      attachments:
        staged.attachments.length === 0 ? undefined : staged.attachments,
      chatId,
      senderDisplayName,
      text: body,
    });
  };

  const handleCallback = async (
    query: TelegramCallbackQuery,
    sink: FrontendSink
  ): Promise<void> => {
    const parsed = parseApprovalCallback(query.data ?? "");
    const { message } = query;
    const chatId = message === undefined ? undefined : chatKeyOf(message);

    if (chatId !== undefined && !isAllowed(chatId)) {
      log.info(
        "Dropped a button press from a Telegram chat that is not in allowedChatIds",
        { chatId }
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

    const won = await sink.decide({
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

  return async (update, sink, me) => {
    try {
      if (update.message !== undefined) {
        await handleMessage(update.message, sink, me);
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
};
