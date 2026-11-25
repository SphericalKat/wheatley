import type { InlineKeyboardMarkup } from "grammy/types";

import { TelegramApiError } from "./client.js";
import type { TelegramClient, TelegramUpload, TextOptions } from "./client.js";
import { HTTP_BAD_REQUEST } from "./http-status.js";

const ALLOWED_UPDATES = ["message", "callback_query"] as const;

const DEFAULT_API_ROOT = "https://api.telegram.org";

const markupOf = (
  options: TextOptions | undefined
): InlineKeyboardMarkup | undefined =>
  options?.keyboard === undefined
    ? undefined
    : {
        inline_keyboard: options.keyboard.map((row) =>
          row.map((button) => ({
            callback_data: button.callbackData,
            text: button.text,
          }))
        ),
      };

/** Options of `createGrammyClient`. */
export interface GrammyClientOptions {
  /** The Bot API server, without a trailing slash. The default is `https://api.telegram.org`. */
  readonly apiRoot?: string;
}

/**
 * Creates a `TelegramClient` backed by grammY. It imports `grammy` on the first call, so Deployments without a Telegram
 * binding never load it (ADR 0012).
 */
export const createGrammyClient = async (
  token: string,
  clientOptions: GrammyClientOptions = {}
): Promise<TelegramClient> => {
  const { Bot, GrammyError, InputFile } = await import("grammy");
  const apiRoot = clientOptions.apiRoot ?? DEFAULT_API_ROOT;
  const bot = new Bot(token, { client: { apiRoot } });
  const { api } = bot;

  const toApiError = (cause: unknown): TelegramApiError => {
    if (cause instanceof GrammyError) {
      return new TelegramApiError(cause.description, {
        cause,
        code: cause.error_code,
        retryAfterSeconds: cause.parameters.retry_after,
      });
    }

    const message = cause instanceof Error ? cause.message : String(cause);

    return new TelegramApiError(message, { cause });
  };

  const call = async <T>(request: () => Promise<T>): Promise<T> => {
    try {
      return await request();
    } catch (error) {
      throw toApiError(error);
    }
  };

  const inputFile = (file: TelegramUpload): InstanceType<typeof InputFile> =>
    "data" in file
      ? new InputFile(file.data, file.filename)
      : new InputFile(file.path, file.filename);

  return {
    answerCallbackQuery: async (callbackQueryId, text) => {
      await call(
        async () =>
          await api.answerCallbackQuery(
            callbackQueryId,
            text === undefined ? undefined : { text }
          )
      );
    },
    downloadFile: async (fileId) => {
      const file = await call(async () => await api.getFile(fileId));

      if (file.file_path === undefined) {
        throw new TelegramApiError("Telegram returned no file path", {
          code: HTTP_BAD_REQUEST,
        });
      }

      const filePath = file.file_path;

      const response = await call(
        async () => await fetch(`${apiRoot}/file/bot${token}/${filePath}`)
      );

      if (!response.ok || response.body === null) {
        throw new TelegramApiError(
          `File download failed with HTTP ${response.status}`,
          { code: response.status }
        );
      }

      return response.body;
    },
    editMessageText: async (chatId, messageId, text, options) => {
      await call(
        async () =>
          await api.editMessageText(chatId, messageId, text, {
            parse_mode: options?.parseMode,
            reply_markup: markupOf(options),
          })
      );
    },
    getMe: async () => {
      const me = await call(async () => await api.getMe());

      return { id: me.id, username: me.username };
    },
    sendFile: async ({ chatId, threadId }, kind, file) => {
      const other = { message_thread_id: threadId };

      if (kind === "photo") {
        const photo = await call(
          async () => await api.sendPhoto(chatId, inputFile(file), other)
        );

        return photo.message_id;
      }

      const document = await call(
        async () => await api.sendDocument(chatId, inputFile(file), other)
      );

      return document.message_id;
    },
    sendMessage: async ({ chatId, threadId }, text, options) => {
      const sent = await call(
        async () =>
          await api.sendMessage(chatId, text, {
            message_thread_id: threadId,
            parse_mode: options?.parseMode,
            reply_markup: markupOf(options),
          })
      );

      return sent.message_id;
    },
    sendTyping: async ({ chatId, threadId }) => {
      await call(
        async () =>
          await api.sendChatAction(chatId, "typing", {
            message_thread_id: threadId,
          })
      );
    },
    setMyCommands: async (commands) => {
      await call(async () => await api.setMyCommands(commands));
    },
    startPolling: async (onUpdate) => {
      bot.use(async (ctx) => {
        await onUpdate(ctx.update);
      });
      await call(async () => {
        await bot.start({
          allowed_updates: [...ALLOWED_UPDATES],
          drop_pending_updates: false,
        });
      });
    },
    stopPolling: async () => {
      if (bot.isRunning()) {
        await call(async () => {
          await bot.stop();
        });
      }
    },
    setWebhook: async (url, secretToken) => {
      await call(
        async () =>
          await api.setWebhook(url, {
            allowed_updates: [...ALLOWED_UPDATES],
            secret_token: secretToken,
          })
      );
    },
  };
};
