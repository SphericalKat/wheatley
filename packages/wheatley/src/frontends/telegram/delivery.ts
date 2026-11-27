import {
  chunkMarkdown,
  DeliveryError,
  isDeliveryError,
} from "@wheatley-ai/sdk";
import type {
  ApprovalRequestedDelivery,
  ApprovalResolvedDelivery,
  Delivery,
  Logger,
  MessageDelivery,
  ModelPicker,
} from "@wheatley-ai/sdk";

import type { ApprovalPromptStore } from "./approvals.js";
import {
  approvalKeyboard,
  approvalRequestText,
  approvalResolvedText,
} from "./approvals.js";
import { attachmentSize, skippedFilesText, toUpload } from "./attachments.js";
import { parseChatKey } from "./chat-key.js";
import type { TelegramTarget } from "./chat-key.js";
import { isApiError, NOT_MODIFIED, TelegramApiError } from "./client.js";
import type { TelegramClient, TextOptions } from "./client.js";
import {
  HTTP_BAD_REQUEST,
  HTTP_FORBIDDEN,
  HTTP_TOO_MANY_REQUESTS,
} from "./http-status.js";
import type { Draft, LiveRuns } from "./live.js";
import { markdownToTelegramHtml } from "./markdown.js";
import type { PickerStore } from "./model-picker.js";
import { openingScreen, pickerToken, toStoredPicker } from "./model-picker.js";
import { RecentSet } from "./recent-set.js";

/** Chunks stay below the 4096-character message limit of the Bot API. */
const MAX_CHUNK_LENGTH = 4000;

const MS_PER_SECOND = 1000;

/** How many delivered message IDs a binding remembers to drop duplicates. */
const DEDUP_CAPACITY = 1000;

const PARSE_ERROR = /can't parse entities/iu;

/** Converts a client error to the `DeliveryError` that the outbox expects. */
const toDeliveryError = (cause: unknown): DeliveryError => {
  if (isDeliveryError(cause)) {
    return cause;
  }

  if (!(cause instanceof TelegramApiError)) {
    const message = cause instanceof Error ? cause.message : String(cause);

    return new DeliveryError(message, { cause, kind: "retryable" });
  }

  if (cause.code === HTTP_TOO_MANY_REQUESTS) {
    return new DeliveryError(cause.message, {
      cause,
      kind: "retryable",
      retryAfterMs:
        cause.retryAfterSeconds === undefined
          ? undefined
          : cause.retryAfterSeconds * MS_PER_SECOND,
    });
  }

  // 400 means a deleted Chat, a deleted topic, or a request that Telegram never accepts. 403 means a removed bot.
  const isPermanent =
    cause.code === HTTP_BAD_REQUEST || cause.code === HTTP_FORBIDDEN;

  return new DeliveryError(cause.message, {
    cause,
    kind: isPermanent ? "permanent" : "retryable",
  });
};

const isBadRequest = (cause: unknown): cause is TelegramApiError =>
  cause instanceof TelegramApiError && cause.code === HTTP_BAD_REQUEST;

/** Progress of one `message` delivery, so a retry resumes after the parts that Telegram already confirmed. */
interface MessageProgress {
  sentParts: number;
  readonly draft: Draft | undefined;
}

/** What the outbound side of a binding needs. */
export interface DelivererDeps {
  readonly client: TelegramClient;
  readonly log: Logger;
  readonly isAllowed: (chatKey: string) => boolean;
  readonly approvals: ApprovalPromptStore;
  readonly pickers: PickerStore;
  readonly live: LiveRuns;
  readonly maxAttachmentBytes: number;
}

/**
 * Creates the `FrontendBinding.deliver` of a Telegram binding.
 *
 * A `message` delivery sends its text chunks in order, then its attachments, then one notice that names the
 * attachments over `maxAttachmentBytes`. A `message` with a `modelPicker` that lists models sends one picker message
 * with an inline keyboard instead of its text. A retry resumes after the parts that Telegram already confirmed, and a
 * delivery that already succeeded is dropped. Rejects with a `DeliveryError`: permanent for an invalid or unlisted
 * Chat and for Bot API codes 400 and 403, retryable for other failures.
 */
export const createDeliverer = (
  deps: DelivererDeps
): ((delivery: Delivery) => Promise<void>) => {
  const {
    approvals,
    client,
    isAllowed,
    live,
    log,
    maxAttachmentBytes,
    pickers,
  } = deps;

  const progress = new Map<string, MessageProgress>();
  const delivered = new RecentSet<string>(DEDUP_CAPACITY);

  const sendFormatted = async (
    target: TelegramTarget,
    markdown: string
  ): Promise<number> => {
    try {
      return await client.sendMessage(
        target,
        markdownToTelegramHtml(markdown),
        { parseMode: "HTML" }
      );
    } catch (error) {
      if (!isApiError(error, PARSE_ERROR)) {
        throw error;
      }

      return await client.sendMessage(target, markdown);
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

      if (isApiError(error, PARSE_ERROR)) {
        await client.editMessageText(chatId, messageId, plain, options);

        return true;
      }

      if (isBadRequest(error)) {
        return false;
      }

      throw error;
    }
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

  const progressOf = async (
    delivery: MessageDelivery,
    target: TelegramTarget
  ): Promise<MessageProgress> => {
    const existing = progress.get(delivery.messageId);

    if (existing !== undefined) {
      return existing;
    }

    const draft =
      delivery.runId === undefined
        ? undefined
        : await live.takeDraft(delivery.runId);

    const sameChat =
      draft?.target.chatId === target.chatId &&
      draft.target.threadId === target.threadId;

    const state = { draft: sameChat ? draft : undefined, sentParts: 0 };
    progress.set(delivery.messageId, state);

    return state;
  };

  const deliverMessage = async (
    delivery: MessageDelivery,
    target: TelegramTarget
  ): Promise<void> => {
    const attachments = delivery.attachments ?? [];

    const uploads = attachments.filter(
      (attachment) => attachmentSize(attachment) <= maxAttachmentBytes
    );

    const skipped = attachments
      .filter((attachment) => attachmentSize(attachment) > maxAttachmentBytes)
      .map((attachment) => attachment.filename);

    if (skipped.length > 0) {
      log.warn("Skipped outbound Telegram attachments over the limit", {
        chatId: delivery.chatId,
        filenames: skipped,
      });
    }

    const chunks = chunkMarkdown(delivery.text, MAX_CHUNK_LENGTH).filter(
      (chunk) => chunk.trim() !== ""
    );

    const state = await progressOf(delivery, target);

    const parts: (() => Promise<void>)[] = [
      ...chunks.map((chunk, index) => async () => {
        await sendChunk(target, chunk, index === 0 ? state.draft : undefined);
      }),
      ...uploads.map((attachment) => async () => {
        const upload = toUpload(attachment);
        await client.sendFile(target, upload.kind, upload.file);
      }),
      ...(skipped.length === 0
        ? []
        : [
            async () => {
              await client.sendMessage(
                target,
                skippedFilesText(skipped, maxAttachmentBytes)
              );
            },
          ]),
    ];

    for (const [index, part] of parts.entries()) {
      if (index < state.sentParts) {
        continue;
      }

      // oxlint-disable-next-line no-await-in-loop -- Parts must arrive in order.
      await part();
      state.sentParts = index + 1;
    }

    progress.delete(delivery.messageId);
    delivered.add(delivery.messageId);
  };

  const deliverModelPicker = async (
    delivery: MessageDelivery,
    picker: ModelPicker,
    target: TelegramTarget
  ): Promise<void> => {
    const token = pickerToken(delivery.messageId);

    if (pickers.get(token) === undefined) {
      const stored = toStoredPicker(delivery.chatId, picker);
      const { keyboard, text } = openingScreen(token, stored);
      await client.sendMessage(target, text, { keyboard, parseMode: "HTML" });
      await pickers.put(token, stored);
    }

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
      target,
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
      await client.sendMessage(target, html, { parseMode: "HTML" });
    }

    await approvals.delete(delivery.approvalId);
    delivered.add(delivery.messageId);
  };

  return async (delivery) => {
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
          const picker = delivery.modelPicker;

          await (picker === undefined || picker.models.length === 0
            ? deliverMessage(delivery, target)
            : deliverModelPicker(delivery, picker, target));
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
};
