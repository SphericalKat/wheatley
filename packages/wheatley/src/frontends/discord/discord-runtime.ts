import type * as DiscordJs from "discord.js";

import type { InboundFile } from "./attachments.js";

/*
 * The part of `discord.js` that the Discord Frontend uses. `loadDiscordRuntime` adapts the real package to it, and the
 * type checker proves that the real `discord.js` objects satisfy these interfaces. Tests provide a fake client.
 */

/** The content of one message that the binding sends or edits. Agent text never pings anyone. */
export interface OutboundMessage {
  readonly content?: string;
  readonly files?: readonly DiscordJs.AttachmentPayload[];
  readonly components?: readonly DiscordJs.ActionRowData<DiscordJs.InteractionButtonComponentData>[];
  readonly allowedMentions?: { readonly parse: readonly [] };
}

/** The `allowedMentions` value that stops a message from pinging anyone. */
export const NO_MENTIONS = {
  parse: [],
} as const satisfies OutboundMessage["allowedMentions"];

/*
 * Errors: every method below that calls the Discord REST API rejects with an error from `@discordjs/rest`.
 * - `DiscordAPIError`: Discord answered with an error. It carries the Discord JSON error `code` and the HTTP `status`.
 * - `HTTPError`: Discord answered with an HTTP error and no JSON body. It carries the HTTP `status`.
 * - `RateLimitError`: the request hit a rate limit that discord.js does not wait out. It carries `retryAfter` in ms.
 * Other errors, such as a network failure, reject with a plain `Error`. `toDeliveryError` in `errors.ts` reads these
 * fields.
 */

/** A message that the bot sent. */
export interface SentMessage {
  readonly id: string;
  /**
   * Replaces the fields of the message that `message` sets and keeps the others. Resolves with the edited message.
   * Rejects with a `DiscordAPIError` (code 10008, Unknown Message) if someone deleted the message.
   */
  readonly edit: (message: OutboundMessage) => Promise<SentMessage>;
  /** Deletes the message. Rejects with a `DiscordAPIError` (code 10008, Unknown Message) if it is already gone. */
  readonly delete: () => Promise<SentMessage>;
}

/** A Discord channel: a DM, a guild channel, or a thread. */
export interface DiscordChannel {
  readonly id: string;
  /** The parent channel of a thread. Absent or `null` for other channels. */
  readonly parentId?: string | null;
  readonly isThread: () => boolean;
  readonly isDMBased: () => boolean;
  readonly isSendable: () => this is SendableChannel;
}

/** A channel that the bot can post to. */
export interface SendableChannel extends DiscordChannel {
  readonly messages: {
    /**
     * Edits a message of this channel by ID, also one that an earlier process sent. Rejects with a `DiscordAPIError`
     * (code 10008, Unknown Message) if the message is gone, and with code 50001 or 50013 if the bot lost access.
     */
    readonly edit: (
      messageId: string,
      message: OutboundMessage
    ) => Promise<SentMessage>;
  };
  /**
   * Posts one message. Messages of one channel appear in the order in which their `send` calls resolve, so callers
   * that need an order must await each call. Rejects with a `DiscordAPIError` for a deleted channel or missing
   * permissions, an `HTTPError` for a 5xx answer, or a `RateLimitError`.
   */
  readonly send: (message: OutboundMessage) => Promise<SentMessage>;
  /**
   * Shows the typing indicator for about 10 seconds, or until the bot posts a message. Rejects like `send`.
   */
  readonly sendTyping: () => Promise<void>;
}

/** A message that arrived through the Gateway. */
export interface DiscordMessage {
  readonly id: string;
  readonly content: string;
  /** Discord system messages, such as a pin notice. */
  readonly system: boolean;
  readonly author: { readonly bot: boolean; readonly displayName: string };
  /** The guild member of the author, or `null` in DMs. */
  readonly member: { readonly displayName: string } | null;
  readonly channel: DiscordChannel;
  readonly mentions: {
    readonly users: { readonly has: (userId: string) => boolean };
    /** The author of the message that this message replies to. */
    readonly repliedUser: { readonly id: string } | null;
  };
  readonly attachments: {
    readonly size: number;
    readonly values: () => Iterable<InboundFile>;
  };
}

/** The answer of Discord to an interaction response. */
export interface InteractionReceipt {
  readonly id: string;
}

/** An ephemeral answer that only the Sender sees. */
export interface EphemeralReply {
  readonly content: string;
  readonly flags: DiscordJs.MessageFlags.Ephemeral;
}

/** A Slash Command or a button press. */
export interface DiscordInteraction {
  /** The channel, or `null` if discord.js has not cached it. */
  readonly channel: DiscordChannel | null;
  readonly channelId: string | null;
  readonly user: { readonly displayName: string };
  readonly isChatInputCommand: () => this is SlashCommandInteraction;
  readonly isButton: () => this is ButtonInteraction;
}

/** A Slash Command. */
export interface SlashCommandInteraction extends DiscordInteraction {
  readonly commandName: string;
  readonly options: {
    readonly getString: (name: string) => string | null;
  };
  readonly deferReply: (options: {
    readonly flags: DiscordJs.MessageFlags.Ephemeral;
  }) => Promise<InteractionReceipt>;
  readonly editReply: (content: string) => Promise<InteractionReceipt>;
}

/** A press of a message button. */
export interface ButtonInteraction extends DiscordInteraction {
  readonly customId: string;
  /** The message that holds the button. */
  readonly message: { readonly content: string };
  readonly reply: (reply: EphemeralReply) => Promise<InteractionReceipt>;
  readonly deferUpdate: () => Promise<InteractionReceipt>;
  /** Edits the message that holds the button, after `deferUpdate`. */
  readonly editReply: (message: OutboundMessage) => Promise<InteractionReceipt>;
  readonly followUp: (reply: EphemeralReply) => Promise<InteractionReceipt>;
}

/** A Discord Gateway client. */
export interface DiscordClient {
  /** The bot user ID, or `undefined` until the client is ready. */
  readonly botUserId: () => string | undefined;
  /**
   * Replaces the Slash Commands: the global ones, or those of one guild if `guildId` is set. Resolves with the number
   * of commands that Discord stored. Rejects before the client is ready.
   */
  readonly setCommands: (
    commands: readonly DiscordJs.ChatInputApplicationCommandData[],
    guildId?: string
  ) => Promise<number>;
  /** Resolves `null` for a channel that the bot cannot see. Rejects with a `DiscordAPIError` for an unknown ID. */
  readonly fetchChannel: (channelId: string) => Promise<DiscordChannel | null>;
  /**
   * Connects to the Gateway. It can resolve before the session is ready, so wait for `onReady`. Rejects for an invalid
   * token. Register every listener before `login`, so that no event arrives without a listener.
   */
  readonly login: (token: string) => Promise<void>;
  /** Closes the Gateway connection and clears the token. Registered listeners stay, but no further events arrive. */
  readonly destroy: () => Promise<void>;
  /**
   * Calls `listener` once, when the Gateway session is ready. discord.js queues Gateway events until then, so no
   * `onMessage` or `onInteraction` event comes before it.
   */
  readonly onReady: (listener: () => void) => void;
  /**
   * Calls `listener` for each message that the bot can see, also its own messages and messages from unlisted
   * channels. The client does not await the listener, so the listener must catch its own errors.
   */
  readonly onMessage: (listener: (message: DiscordMessage) => void) => void;
  /**
   * Calls `listener` for each Slash Command and component interaction. Discord expects an answer within 3 seconds, so
   * the listener must defer or reply before slow work. The client does not await the listener.
   */
  readonly onInteraction: (
    listener: (interaction: DiscordInteraction) => void
  ) => void;
  /**
   * Calls `listener` for client errors that have no caller, for example a failed Gateway reconnect. Without a listener,
   * discord.js throws such errors and the process crashes.
   */
  readonly onError: (listener: (error: Error) => void) => void;
}

/** The `discord.js` enums that the binding reads, and a client factory. */
export interface DiscordRuntime extends Pick<
  typeof DiscordJs,
  | "ApplicationCommandOptionType"
  | "ButtonStyle"
  | "ComponentType"
  | "GatewayIntentBits"
  | "MessageFlags"
  | "Partials"
> {
  readonly createClient: (options: DiscordJs.ClientOptions) => DiscordClient;
}

/** Adapts a `discord.js` client to `DiscordClient`. */
export const adaptClient = (
  discord: typeof DiscordJs,
  client: DiscordJs.Client
): DiscordClient => ({
  botUserId: () => client.user?.id,
  destroy: async () => {
    await client.destroy();
  },
  fetchChannel: async (channelId) => await client.channels.fetch(channelId),
  login: async (token) => {
    await client.login(token);
  },
  onError: (listener) => {
    client.on(discord.Events.Error, listener);
  },
  onInteraction: (listener) => {
    client.on(discord.Events.InteractionCreate, listener);
  },
  onMessage: (listener) => {
    client.on(discord.Events.MessageCreate, listener);
  },
  onReady: (listener) => {
    client.once(discord.Events.ClientReady, () => {
      listener();
    });
  },
  setCommands: async (commands, guildId) => {
    const { application } = client;

    if (application === null) {
      throw new Error("The Discord client is not ready");
    }

    const stored =
      guildId === undefined
        ? await application.commands.set(commands)
        : await application.commands.set(commands, guildId);

    return stored.size;
  },
});

/** Loads `discord.js` on first use, so that Agents without a Discord binding never load it (ADR 0012). */
export const loadDiscordRuntime = async (): Promise<DiscordRuntime> => {
  const discord = await import("discord.js");

  return {
    ApplicationCommandOptionType: discord.ApplicationCommandOptionType,
    ButtonStyle: discord.ButtonStyle,
    ComponentType: discord.ComponentType,
    GatewayIntentBits: discord.GatewayIntentBits,
    MessageFlags: discord.MessageFlags,
    Partials: discord.Partials,
    createClient: (options) =>
      adaptClient(discord, new discord.Client(options)),
  };
};
