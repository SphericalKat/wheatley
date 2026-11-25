/** A Telegram Chat ID or a forum topic key, as `allowedChatIds` accepts it. */
export const ALLOWLIST_ENTRY = /^-?\d+(?::topic:\d+)?$/u;

const CHAT_KEY = /^(?<chat>-?\d+)(?::topic:(?<thread>\d+))?$/u;

/** Where a Wheatley Chat lives on Telegram: a DM, a group, or one forum topic of a supergroup (ADR 0012). */
export interface TelegramTarget {
  readonly chatId: number;
  /** The forum topic. Absent for a DM, a group, and the General topic of a forum. */
  readonly threadId?: number;
}

/** The fields of a Telegram message that decide its Chat. */
export interface ChatLocation {
  readonly chat: { readonly id: number };
  readonly message_thread_id?: number;
  readonly is_topic_message?: boolean;
}

/** Returns the Wheatley Chat ID: `<chat_id>`, or `<chat_id>:topic:<thread_id>` for a forum topic message. */
export const chatKeyOf = (location: ChatLocation): string => {
  const thread = location.message_thread_id;

  return location.is_topic_message === true && thread !== undefined
    ? `${location.chat.id}:topic:${thread}`
    : String(location.chat.id);
};

/** Parses a Wheatley Chat ID of this Frontend. Returns `undefined` for an ID in another format. */
export const parseChatKey = (chatKey: string): TelegramTarget | undefined => {
  const groups = CHAT_KEY.exec(chatKey)?.groups;
  const chat = groups?.chat;

  if (chat === undefined) {
    return undefined;
  }

  const chatId = Number(chat);
  const thread = groups?.thread;

  if (!Number.isSafeInteger(chatId)) {
    return undefined;
  }

  return thread === undefined
    ? { chatId }
    : { chatId, threadId: Number(thread) };
};

/** The parent Chat ID of a Chat key: the group of a forum topic, or the key itself. */
const parentOf = (chatKey: string): string =>
  chatKey.split(":topic:")[0] ?? chatKey;

/**
 * Creates the allowlist check of a binding. A key passes if `allowedChatIds` lists the key itself or its parent group,
 * so one entry for a forum supergroup allows all of its topics.
 */
export const createAllowlist = (
  allowedChatIds: readonly string[]
): ((chatKey: string) => boolean) => {
  const allowed = new Set(allowedChatIds);

  return (chatKey) => allowed.has(chatKey) || allowed.has(parentOf(chatKey));
};
