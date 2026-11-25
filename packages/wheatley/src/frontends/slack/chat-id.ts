/** Where a Chat lives on Slack: a conversation, and a thread inside it if the Chat is a thread. */
export interface SlackChatTarget {
  readonly channel: string;
  readonly threadTs: string | undefined;
}

/**
 * Returns the Chat ID of a Slack conversation or thread (ADR 0012): `<channel_id>` for a DM or channel, and
 * `<channel_id>:<thread_ts>` for a thread.
 */
export const toChatId = (channel: string, threadTs?: string): string =>
  threadTs === undefined ? channel : `${channel}:${threadTs}`;

/** Splits a Chat ID from `toChatId` into its channel and thread. */
export const parseChatId = (chatId: string): SlackChatTarget => {
  const separator = chatId.indexOf(":");

  return separator === -1
    ? { channel: chatId, threadTs: undefined }
    : {
        channel: chatId.slice(0, separator),
        threadTs: chatId.slice(separator + 1),
      };
};

/** Returns true if `allowed` lists the Chat itself or its parent channel. */
export const isChatAllowed = (
  allowed: ReadonlySet<string>,
  chatId: string
): boolean => allowed.has(chatId) || allowed.has(parseChatId(chatId).channel);
