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

/** A message that the bot sent. */
export interface SentMessage {
  readonly id: string;
  readonly edit: (message: OutboundMessage) => Promise<SentMessage>;
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
    readonly edit: (
      messageId: string,
      message: OutboundMessage
    ) => Promise<SentMessage>;
  };
  readonly send: (message: OutboundMessage) => Promise<SentMessage>;
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
  /** Connects to the Gateway. Rejects for an invalid token. */
  readonly login: (token: string) => Promise<void>;
  readonly destroy: () => Promise<void>;
  /** Calls `listener` once, when the Gateway session is ready. */
  readonly onReady: (listener: () => void) => void;
  readonly onMessage: (listener: (message: DiscordMessage) => void) => void;
  readonly onInteraction: (
    listener: (interaction: DiscordInteraction) => void
  ) => void;
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

const adaptClient = (
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
