import type { TelegramTarget } from "./chat-key.js";
import type {
  BotIdentity,
  TelegramClient,
  TelegramUpdate,
  TelegramUpload,
  TextOptions,
  UploadKind,
} from "./client.js";

/** A message that the fake recorded. */
export interface SentMessage {
  readonly chatId: number;
  readonly threadId: number | undefined;
  readonly text: string;
  readonly options: TextOptions | undefined;
  readonly messageId: number;
}

/** An edit that the fake recorded. */
export interface EditedMessage {
  readonly chatId: number;
  readonly messageId: number;
  readonly text: string;
  readonly options: TextOptions | undefined;
}

/** A file upload that the fake recorded. */
export interface SentFile {
  readonly chatId: number;
  readonly threadId: number | undefined;
  readonly kind: UploadKind;
  readonly file: TelegramUpload;
}

type FailingMethod =
  | "sendMessage"
  | "editMessageText"
  | "sendFile"
  | "getMe"
  | "setMyCommands";

/**
 * An in-memory `TelegramClient`. It records every call, serves files from `files`, feeds updates from `push` to the
 * polling handler, and rejects the next calls of a method with the errors from `failNext`.
 */
export class FakeTelegramClient implements TelegramClient {
  readonly bot = {
    id: 999,
    username: "wheatley_bot",
  } as const satisfies BotIdentity;
  readonly sent: SentMessage[] = [];
  readonly edits: EditedMessage[] = [];
  readonly files: SentFile[] = [];
  readonly typing: { chatId: number; threadId: number | undefined }[] = [];
  readonly answers: { id: string; text: string | undefined }[] = [];
  readonly webhooks: { url: string; secretToken: string }[] = [];
  commands: readonly { command: string; description: string }[] = [];
  /** File contents by `file_id`, as download chunks. */
  readonly downloads = new Map<string, readonly Uint8Array[]>();
  polling = false;

  #nextMessageId = 100;
  readonly #failures = new Map<FailingMethod, Error[]>();
  #onUpdate: ((update: TelegramUpdate) => Promise<void>) | undefined;
  #stopPolling: ((value: undefined) => void) | undefined;

  /** Makes the next call of `method` reject with `error`. Calls queue in order. */
  readonly failNext = (method: FailingMethod, error: Error): void => {
    this.#failures.set(method, [...(this.#failures.get(method) ?? []), error]);
  };

  /** Hands an update to the polling handler and waits until the handler finishes. */
  readonly push = async (update: TelegramUpdate): Promise<void> => {
    if (this.#onUpdate === undefined) {
      throw new Error("Polling has not started");
    }

    await this.#onUpdate(update);
  };

  readonly getMe = async (): Promise<BotIdentity> => {
    await this.#io("getMe");

    return this.bot;
  };

  readonly startPolling = async (
    onUpdate: (update: TelegramUpdate) => Promise<void>
  ): Promise<void> => {
    this.#onUpdate = onUpdate;
    this.polling = true;
    const stopped = Promise.withResolvers<undefined>();
    this.#stopPolling = stopped.resolve;
    await stopped.promise;
    this.polling = false;
  };

  readonly stopPolling = async (): Promise<void> => {
    await Promise.resolve();
    this.#stopPolling?.(undefined);
  };

  readonly setWebhook = async (
    url: string,
    secretToken: string
  ): Promise<void> => {
    await Promise.resolve();
    this.webhooks.push({ secretToken, url });
  };

  readonly setMyCommands = async (
    commands: readonly { command: string; description: string }[]
  ): Promise<void> => {
    await this.#io("setMyCommands");
    this.commands = commands;
  };

  readonly sendMessage = async (
    { chatId, threadId }: TelegramTarget,
    text: string,
    options?: TextOptions
  ): Promise<number> => {
    await this.#io("sendMessage");
    this.#nextMessageId += 1;
    const messageId = this.#nextMessageId;
    this.sent.push({ chatId, messageId, options, text, threadId });

    return messageId;
  };

  readonly editMessageText = async (
    chatId: number,
    messageId: number,
    text: string,
    options?: TextOptions
  ): Promise<void> => {
    await this.#io("editMessageText");
    this.edits.push({ chatId, messageId, options, text });
  };

  readonly sendTyping = async ({
    chatId,
    threadId,
  }: TelegramTarget): Promise<void> => {
    await Promise.resolve();
    this.typing.push({ chatId, threadId });
  };

  readonly sendFile = async (
    { chatId, threadId }: TelegramTarget,
    kind: UploadKind,
    file: TelegramUpload
  ): Promise<number> => {
    await this.#io("sendFile");
    this.files.push({ chatId, file, kind, threadId });
    this.#nextMessageId += 1;

    return this.#nextMessageId;
  };

  readonly answerCallbackQuery = async (
    callbackQueryId: string,
    text?: string
  ): Promise<void> => {
    await Promise.resolve();
    this.answers.push({ id: callbackQueryId, text });
  };

  readonly downloadFile = async (
    fileId: string
  ): Promise<AsyncIterable<Uint8Array>> => {
    await Promise.resolve();
    const chunks = this.downloads.get(fileId);

    if (chunks === undefined) {
      throw new Error(`Unknown file: ${fileId}`);
    }

    return (async function* stream(): AsyncGenerator<Uint8Array> {
      yield* chunks;
    })();
  };

  readonly #io = async (method: FailingMethod): Promise<void> => {
    await Promise.resolve();
    const [failure, ...rest] = this.#failures.get(method) ?? [];

    if (failure !== undefined) {
      this.#failures.set(method, rest);
      throw failure;
    }
  };
}
