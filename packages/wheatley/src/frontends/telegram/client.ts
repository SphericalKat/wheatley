import { Type } from "typebox";
import type { Static } from "typebox";

/*
 * The Telegram Bot API subset that the Telegram Frontend uses. `grammy-client.ts` implements it with grammY, and
 * tests replace it with a fake. The update schemas list only the fields that the Frontend reads and accept any other
 * field, so a Telegram API update is assignable to them.
 */

const UserSchema = Type.Object({
  first_name: Type.String(),
  id: Type.Number(),
  is_bot: Type.Boolean(),
  last_name: Type.Optional(Type.String()),
  username: Type.Optional(Type.String()),
});

export type TelegramUser = Static<typeof UserSchema>;

const ChatSchema = Type.Object({
  id: Type.Number(),
  is_forum: Type.Optional(Type.Boolean()),
  type: Type.String(),
});

const EntitySchema = Type.Object({
  length: Type.Number(),
  offset: Type.Number(),
  type: Type.String(),
  user: Type.Optional(UserSchema),
});

export type TelegramEntity = Static<typeof EntitySchema>;

const FileSchema = Type.Object({
  file_id: Type.String(),
  file_name: Type.Optional(Type.String()),
  file_size: Type.Optional(Type.Number()),
  mime_type: Type.Optional(Type.String()),
});

export type TelegramFile = Static<typeof FileSchema>;

const PhotoSizeSchema = Type.Object({
  file_id: Type.String(),
  file_size: Type.Optional(Type.Number()),
  height: Type.Number(),
  width: Type.Number(),
});

const MessageSchema = Type.Object({
  animation: Type.Optional(FileSchema),
  audio: Type.Optional(FileSchema),
  caption: Type.Optional(Type.String()),
  caption_entities: Type.Optional(Type.Array(EntitySchema)),
  chat: ChatSchema,
  document: Type.Optional(FileSchema),
  entities: Type.Optional(Type.Array(EntitySchema)),
  from: Type.Optional(UserSchema),
  is_topic_message: Type.Optional(Type.Boolean()),
  message_id: Type.Number(),
  message_thread_id: Type.Optional(Type.Number()),
  photo: Type.Optional(Type.Array(PhotoSizeSchema)),
  reply_to_message: Type.Optional(
    Type.Object({
      from: Type.Optional(UserSchema),
      message_id: Type.Number(),
    })
  ),
  text: Type.Optional(Type.String()),
  video: Type.Optional(FileSchema),
  video_note: Type.Optional(FileSchema),
  voice: Type.Optional(FileSchema),
});

export type TelegramMessage = Static<typeof MessageSchema>;

const CallbackQuerySchema = Type.Object({
  data: Type.Optional(Type.String()),
  from: UserSchema,
  id: Type.String(),
  message: Type.Optional(
    Type.Object({
      chat: ChatSchema,
      is_topic_message: Type.Optional(Type.Boolean()),
      message_id: Type.Number(),
      message_thread_id: Type.Optional(Type.Number()),
    })
  ),
});

export type TelegramCallbackQuery = Static<typeof CallbackQuerySchema>;

/** The parts of a Telegram `Update` that the Frontend handles. */
export const TelegramUpdateSchema = Type.Object({
  callback_query: Type.Optional(CallbackQuerySchema),
  message: Type.Optional(MessageSchema),
  update_id: Type.Number(),
});

export type TelegramUpdate = Static<typeof TelegramUpdateSchema>;

/** One button of an inline keyboard. */
export interface InlineButton {
  readonly text: string;
  /** At most 64 bytes. */
  readonly callbackData: string;
}

/** Options for a sent or edited text message. */
export interface TextOptions {
  /** Absent for plain text. */
  readonly parseMode?: "HTML";
  /** Rows of buttons. An empty array removes the keyboard of an edited message. */
  readonly keyboard?: readonly (readonly InlineButton[])[];
}

/** A file to upload. */
export type TelegramUpload =
  | { readonly filename: string; readonly data: Uint8Array }
  | { readonly filename: string; readonly path: string };

/** The kind of upload: Telegram shows a `photo` inline and a `document` as a file. */
export type UploadKind = "photo" | "document";

/** The bot account, from `getMe`. */
export interface BotIdentity {
  readonly id: number;
  readonly username: string;
}

/** A failed Bot API call. */
export class TelegramApiError extends Error {
  override readonly name = "TelegramApiError";
  /** The Bot API `error_code`, for example 403 or 429. Absent for a network error. */
  readonly code: number | undefined;
  /** The Bot API `parameters.retry_after`, in seconds. */
  readonly retryAfterSeconds: number | undefined;

  constructor(
    message: string,
    options: {
      readonly code?: number;
      readonly retryAfterSeconds?: number;
      readonly cause?: unknown;
    } = {}
  ) {
    super(message, { cause: options.cause });
    this.code = options.code;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

/**
 * The Telegram Bot API as the Frontend uses it.
 *
 * Errors: every method rejects with a `TelegramApiError`, with `code` set for an error response of the Bot API and
 * unset for a network error or an aborted call.
 */
export interface TelegramClient {
  readonly getMe: () => Promise<BotIdentity>;
  /**
   * Removes any webhook and long-polls for updates. Calls `onUpdate` for each update, one at a time, in order, and
   * confirms an update to Telegram only after `onUpdate` resolves. Retries temporary errors itself. `onUpdate` must not
   * reject.
   *
   * Resolves after `stopPolling`. Rejects on a fatal error, for example a revoked token (401) or a second process that
   * polls with the same token (409).
   */
  readonly startPolling: (
    onUpdate: (update: TelegramUpdate) => Promise<void>
  ) => Promise<void>;
  /** Stops polling and cancels the request in flight. Does nothing if polling does not run. */
  readonly stopPolling: () => Promise<void>;
  /** Makes Telegram send updates to `url` with the `X-Telegram-Bot-Api-Secret-Token` header set to `secretToken`. */
  readonly setWebhook: (url: string, secretToken: string) => Promise<void>;
  readonly setMyCommands: (
    commands: readonly {
      readonly command: string;
      readonly description: string;
    }[]
  ) => Promise<void>;
  /** Resolves with the `message_id` of the sent message. */
  readonly sendMessage: (
    chatId: number,
    threadId: number | undefined,
    text: string,
    options?: TextOptions
  ) => Promise<number>;
  /** Telegram rejects an edit to the same text and keyboard with code 400 and `message is not modified`. */
  readonly editMessageText: (
    chatId: number,
    messageId: number,
    text: string,
    options?: TextOptions
  ) => Promise<void>;
  /** Shows the typing indicator for about five seconds. */
  readonly sendTyping: (
    chatId: number,
    threadId: number | undefined
  ) => Promise<void>;
  /** Resolves with the `message_id` of the sent message. */
  readonly sendFile: (
    chatId: number,
    threadId: number | undefined,
    kind: UploadKind,
    file: TelegramUpload
  ) => Promise<number>;
  readonly answerCallbackQuery: (
    callbackQueryId: string,
    text?: string
  ) => Promise<void>;
  /**
   * Streams the contents of a file that a user sent. Rejects with code 400 if Telegram cannot serve the file, for
   * example because it is larger than 20 MB.
   */
  readonly downloadFile: (fileId: string) => Promise<AsyncIterable<Uint8Array>>;
}
