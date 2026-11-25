import { DISPLAY_NAME_MAX_LENGTH } from "@wheatley-ai/protocol";
import type {
  ApprovalRequestedDelivery,
  ApprovalResolvedDelivery,
  CommandSpec,
  Delivery,
  FrontendBinding,
  FrontendContext,
  FrontendSink,
  MessageDelivery,
  RunEvent,
} from "@wheatley-ai/sdk";
import {
  chunkMarkdown,
  DeliveryError,
  parseCommandText,
} from "@wheatley-ai/sdk";
import type * as DiscordJs from "discord.js";

import {
  approvalButtons,
  parseApprovalCustomId,
  promptContent,
  promptKey,
  PromptStore,
  resolvedContent,
} from "./approvals.js";
import {
  MAX_FILES_PER_MESSAGE,
  stageInboundFiles,
  toUploadPayloads,
} from "./attachments.js";
import type { DiscordConfig } from "./config.js";
import { loadDiscordRuntime, NO_MENTIONS } from "./discord-runtime.js";
import type {
  ButtonInteraction,
  DiscordChannel,
  DiscordClient,
  DiscordInteraction,
  DiscordMessage,
  DiscordRuntime,
  OutboundMessage,
  SendableChannel,
  SlashCommandInteraction,
} from "./discord-runtime.js";
import {
  discordErrorCode,
  errorText,
  toDeliveryError,
  UNKNOWN_MESSAGE_CODE,
} from "./errors.js";
import { DISCORD_MESSAGE_MAX_LENGTH, LiveRuns } from "./live-runs.js";
import { RecentIds } from "./recent-ids.js";

/** Third-party seams of the Discord Frontend. Production code uses the defaults. */
export interface DiscordFrontendOptions {
  /** Downloads inbound attachments from the Discord CDN. The default is the global `fetch`. */
  readonly fetch?: typeof fetch;
  /** Provides `discord.js`. The default loads the real package on the first `start`. */
  readonly loadDiscord?: () => Promise<DiscordRuntime>;
}

/** How many outbound `messageId` values the binding remembers to drop duplicate deliveries. */
const RECENT_DELIVERY_LIMIT = 1000;

const OPTION_NAME_UNSAFE = /[^a-z0-9_-]+/gu;
const DEFAULT_OPTION_NAME = "args";

/** Derives the Slash Command option name from a command argument hint, for example `<model-id>` to `model-id`. */
const optionName = (argument: string): string => {
  const name = argument.toLowerCase().replaceAll(OPTION_NAME_UNSAFE, "");

  return name === "" ? DEFAULT_OPTION_NAME : name;
};

const displayName = (name: string): string =>
  name.slice(0, DISPLAY_NAME_MAX_LENGTH);

/** Splits Agent text and files into Discord messages: text chunks first, files on the last chunk or after it. */
const outboundPayloads = (
  text: string,
  files: readonly DiscordJs.AttachmentPayload[]
): OutboundMessage[] => {
  const chunks =
    text.trim() === "" ? [] : chunkMarkdown(text, DISCORD_MESSAGE_MAX_LENGTH);

  const fileGroups: DiscordJs.AttachmentPayload[][] = [];

  for (let start = 0; start < files.length; start += MAX_FILES_PER_MESSAGE) {
    fileGroups.push(files.slice(start, start + MAX_FILES_PER_MESSAGE));
  }

  const lastChunk = chunks.at(-1);
  const [firstGroup, ...otherGroups] = fileGroups;

  const textPayloads: OutboundMessage[] = chunks
    .slice(0, -1)
    .map((content) => ({ allowedMentions: NO_MENTIONS, content }));

  if (lastChunk !== undefined) {
    textPayloads.push({
      allowedMentions: NO_MENTIONS,
      content: lastChunk,
      files: firstGroup,
    });
  }

  const separateGroups = lastChunk === undefined ? fileGroups : otherGroups;

  return [
    ...textPayloads,
    ...separateGroups.map((group) => ({
      allowedMentions: NO_MENTIONS,
      files: group,
    })),
  ];
};

/** The connection state after `start` succeeded. */
interface Connection {
  readonly discord: DiscordRuntime;
  readonly client: DiscordClient;
  readonly sink: FrontendSink;
  readonly botId: string;
  readonly botMention: RegExp;
}

/** The parent channel ID of a thread, or `null` for other channels. */
const parentOf = (channel: DiscordChannel): string | null =>
  channel.isThread() ? (channel.parentId ?? null) : null;

/** The channel of an interaction. Fetches it if discord.js has not cached it, for example a DM channel. */
const interactionChannel = async (
  interaction: DiscordInteraction,
  client: DiscordClient
): Promise<DiscordChannel | null> => {
  if (interaction.channel !== null) {
    return interaction.channel;
  }

  return interaction.channelId === null
    ? null
    : await client.fetchChannel(interaction.channelId);
};

/** Hands a native Slash Command to the Agent and answers the Sender with an ephemeral receipt. */
const handleSlashCommand = async (
  interaction: SlashCommandInteraction,
  chatId: string,
  { discord, sink }: Connection
): Promise<void> => {
  const spec = sink.commands.find(
    (command) => command.name === interaction.commandName
  );

  if (spec === undefined) {
    return;
  }

  await interaction.deferReply({ flags: discord.MessageFlags.Ephemeral });

  const raw =
    spec.argument === undefined
      ? null
      : interaction.options.getString(optionName(spec.argument));

  const args = raw?.trim() ?? "";

  try {
    await sink.command({
      chatId,
      name: spec.name,
      senderDisplayName: displayName(interaction.user.displayName),
      args: args === "" ? undefined : args,
    });
  } catch (error) {
    await interaction.editReply(`Wheatley could not run \`/${spec.name}\`.`);

    throw error;
  }

  await interaction.editReply(`Accepted \`/${spec.name}\`.`);
};

/**
 * One Discord bot connected to one Agent over the Discord Gateway (ADR 0007, ADR 0012).
 *
 * Chats: a DM channel, a guild channel, and a thread each are a separate Chat whose ID is the Discord channel ID, so
 * a thread maps to `<thread_id>`. A Chat is allowed if its ID, or for a thread the parent channel ID, is in
 * `allowedChatIds`. The binding drops other messages. It logs their Chat ID at `info` level if the message addresses
 * the bot (a DM, a mention, or a reply to the bot), so that busy guild channels do not flood the log (ADR 0012).
 */
export class DiscordBinding implements FrontendBinding {
  readonly #config: DiscordConfig;
  readonly #ctx: FrontendContext;
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #loadDiscord: () => Promise<DiscordRuntime>;
  readonly #allowed: ReadonlySet<string>;
  readonly #prompts: PromptStore;
  readonly #delivered = new RecentIds(RECENT_DELIVERY_LIMIT);
  readonly #live: LiveRuns;
  #client: DiscordClient | undefined;
  #connection: Connection | undefined;

  constructor(
    config: DiscordConfig,
    ctx: FrontendContext,
    token: string,
    options: DiscordFrontendOptions
  ) {
    this.#config = config;
    this.#ctx = ctx;
    this.#token = token;
    this.#fetch = options.fetch ?? fetch;
    this.#loadDiscord = options.loadDiscord ?? loadDiscordRuntime;
    this.#allowed = new Set(config.allowedChatIds);
    this.#prompts = new PromptStore(ctx.dataDir);
    this.#live = new LiveRuns({
      editIntervalMs: config.editIntervalMs,
      log: ctx.log,
      mode: config.streaming,
      resolveChannel: async (chatId) => await this.#resolveChannel(chatId),
    });
  }

  /**
   * Loads `discord.js`, logs in, waits for the Gateway `clientReady` event, and registers the built-in commands as
   * Slash Commands: in each `commandGuildIds` guild, or globally if the list is empty.
   *
   * Rejects if the stored Approval prompts cannot load or the login fails. A failed command registration only logs an
   * error, because text commands still work.
   */
  readonly start = async (sink: FrontendSink): Promise<void> => {
    await this.#prompts.load();
    const discord = await this.#loadDiscord();

    const client = discord.createClient({
      intents: [
        discord.GatewayIntentBits.Guilds,
        discord.GatewayIntentBits.GuildMessages,
        discord.GatewayIntentBits.MessageContent,
        discord.GatewayIntentBits.DirectMessages,
      ],
      // Discord sends DM channels as partial objects. Without this, discord.js drops DMs.
      partials: [discord.Partials.Channel],
    });

    this.#client = client;

    client.onMessage((message) => {
      void this.#guard("handle a Discord message", async () => {
        await this.#onMessage(message);
      });
    });
    client.onInteraction((interaction) => {
      void this.#guard("handle a Discord interaction", async () => {
        await this.#onInteraction(interaction);
      });
    });
    client.onError((failure) => {
      this.#ctx.log.error("The Discord client reported an error", {
        error: failure.message,
      });
    });

    const ready = Promise.withResolvers<undefined>();

    client.onReady(() => {
      ready.resolve(undefined);
    });
    await client.login(this.#token);
    await ready.promise;

    const botId = client.botUserId();

    if (botId === undefined) {
      throw new Error("The Discord client reported ready without a bot user");
    }

    this.#connection = {
      botId,
      botMention: new RegExp(String.raw`<@!?${botId}>\s*`, "gu"),
      client,
      discord,
      sink,
    };
    await this.#registerCommands(sink.commands);
  };

  /**
   * Delivers durable outbound work. Drops a `messageId` that this binding delivered before.
   *
   * A `message` with a `runId` replaces the draft message of that Run with its first chunk. Rejects with a
   * `DeliveryError`: `permanent` for an unknown, non-text, or not-allowed Chat, a file over the limit, or a Discord
   * 4xx answer such as Missing Access; `retryable` before `start` finishes and for rate limits, 5xx, and network
   * errors.
   */
  readonly deliver = async (delivery: Delivery): Promise<void> => {
    if (this.#delivered.has(delivery.messageId)) {
      return;
    }

    try {
      await this.#deliver(delivery);
    } catch (error) {
      throw toDeliveryError(
        error,
        `deliver ${delivery.kind} ${delivery.messageId} to Chat ${delivery.chatId}`
      );
    }

    this.#delivered.add(delivery.messageId);
  };

  /** Shows typing and, in `edit` mode, a throttled draft message. Never throws or blocks. */
  readonly onEvent = (event: RunEvent): void => {
    this.#live.onEvent(event);
  };

  /** Stops live views and closes the Gateway connection. Resolves also after a failed `start`. */
  readonly stop = async (): Promise<void> => {
    this.#live.dispose();
    const client = this.#client;
    this.#client = undefined;
    this.#connection = undefined;

    try {
      await client?.destroy();
    } catch (error) {
      this.#ctx.log.warn("The Discord client did not close cleanly", {
        error: errorText(error),
      });
    }
  };

  /** Runs an event handler and logs its failure, because a Gateway event has no caller to report to. */
  async #guard(action: string, step: () => Promise<void>): Promise<void> {
    try {
      await step();
    } catch (error) {
      this.#ctx.log.error(`Wheatley could not ${action}`, {
        error: errorText(error),
      });
    }
  }

  #isAllowed(channel: DiscordChannel): boolean {
    if (this.#allowed.has(channel.id)) {
      return true;
    }

    const parentId = parentOf(channel);

    return parentId !== null && this.#allowed.has(parentId);
  }

  #logDropped(channel: DiscordChannel): void {
    const parentId = parentOf(channel);

    this.#ctx.log.info(
      "Dropped a Discord message from a Chat that is not in allowedChatIds",
      { chatId: channel.id, parentId }
    );
  }

  async #registerCommands(commands: readonly CommandSpec[]): Promise<void> {
    const connection = this.#connection;

    if (connection === undefined) {
      return;
    }

    const { discord, client } = connection;

    const data: DiscordJs.ChatInputApplicationCommandData[] = commands.map(
      (spec) => ({
        description: spec.description,
        name: spec.name,
        options:
          spec.argument === undefined
            ? []
            : [
                {
                  description: spec.argument,
                  name: optionName(spec.argument),
                  required: false,
                  type: discord.ApplicationCommandOptionType.String,
                },
              ],
      })
    );

    try {
      const guildIds = this.#config.commandGuildIds;

      await (guildIds.length === 0
        ? client.setCommands(data)
        : Promise.all(
            guildIds.map(
              async (guildId) => await client.setCommands(data, guildId)
            )
          ));
    } catch (error) {
      this.#ctx.log.error("Discord rejected the Slash Command registration", {
        error: errorText(error),
      });
    }
  }

  #addressesBot(message: DiscordMessage, botId: string): boolean {
    if (message.channel.isDMBased()) {
      return true;
    }

    if (this.#config.guildMessages === "all") {
      return true;
    }

    return (
      message.mentions.users.has(botId) ||
      message.mentions.repliedUser?.id === botId
    );
  }

  async #onMessage(message: DiscordMessage): Promise<void> {
    const connection = this.#connection;
    const ignored = message.author.bot || message.system;

    if (connection === undefined || ignored) {
      return;
    }

    if (!this.#addressesBot(message, connection.botId)) {
      return;
    }

    const { channel } = message;

    if (!this.#isAllowed(channel)) {
      this.#logDropped(channel);

      return;
    }

    const chatId = channel.id;
    const text = message.content.replaceAll(connection.botMention, "").trim();

    const senderDisplayName = displayName(
      message.member?.displayName ?? message.author.displayName
    );

    const command =
      message.attachments.size === 0 ? parseCommandText(text) : undefined;

    if (command !== undefined) {
      await connection.sink.command({
        chatId,
        name: command.name,
        senderDisplayName,
        args: command.args,
      });

      return;
    }

    const staged = await stageInboundFiles(message.attachments.values(), {
      fetch: this.#fetch,
      maxBytes: this.#ctx.maxAttachmentBytes,
      prefix: `discord-${message.id}`,
      stagingDir: this.#ctx.stagingDir,
    });

    const fullText = [text, ...staged.notes]
      .filter((line) => line !== "")
      .join("\n");

    if (fullText === "" && staged.attachments.length === 0) {
      return;
    }

    await connection.sink.send({
      chatId,
      senderDisplayName,
      text: fullText,
      attachments:
        staged.attachments.length === 0 ? undefined : staged.attachments,
    });
  }

  async #onInteraction(interaction: DiscordInteraction): Promise<void> {
    const connection = this.#connection;

    if (connection === undefined) {
      return;
    }

    const isOwn =
      interaction.isChatInputCommand() ||
      (interaction.isButton() &&
        parseApprovalCustomId(interaction.customId) !== undefined);

    if (!isOwn) {
      return;
    }

    const channel = await interactionChannel(interaction, connection.client);

    if (channel === null) {
      return;
    }

    if (!this.#isAllowed(channel)) {
      this.#logDropped(channel);

      return;
    }

    if (interaction.isChatInputCommand()) {
      await handleSlashCommand(interaction, channel.id, connection);
    } else if (interaction.isButton()) {
      await this.#onApprovalButton(interaction, channel.id, connection);
    }
  }

  async #onApprovalButton(
    interaction: ButtonInteraction,
    chatId: string,
    { discord, sink }: Connection
  ): Promise<void> {
    const press = parseApprovalCustomId(interaction.customId);

    if (press === undefined) {
      return;
    }

    const prompt = this.#prompts.lookup(press.key);

    if (prompt === undefined) {
      await interaction.reply({
        content: "This Approval is no longer available.",
        flags: discord.MessageFlags.Ephemeral,
      });

      return;
    }

    await interaction.deferUpdate();
    const resolvedBy = displayName(interaction.user.displayName);

    const won = await sink.decide({
      approvalId: prompt.approvalId,
      chatId,
      resolution: { decision: press.decision, resolvedBy },
    });

    if (!won) {
      await interaction.followUp({
        content: "This Approval already ended.",
        flags: discord.MessageFlags.Ephemeral,
      });

      return;
    }

    await interaction.editReply({
      components: [approvalButtons(discord, press.key, true)],
      content: resolvedContent(
        prompt.record?.content ?? interaction.message.content,
        press.decision,
        resolvedBy
      ),
    });
  }

  #requireConnection(): Connection {
    if (this.#connection === undefined) {
      throw new DeliveryError("The Discord binding is not connected", {
        kind: "retryable",
      });
    }

    return this.#connection;
  }

  async #resolveChannel(chatId: string): Promise<SendableChannel> {
    const connection = this.#requireConnection();
    const channel = await connection.client.fetchChannel(chatId);

    if (channel === null || !channel.isSendable()) {
      throw new DeliveryError(`Chat ${chatId} is not a Discord text channel`, {
        kind: "permanent",
      });
    }

    if (!this.#isAllowed(channel)) {
      throw new DeliveryError(`Chat ${chatId} is not in allowedChatIds`, {
        kind: "permanent",
      });
    }

    return channel;
  }

  async #deliver(delivery: Delivery): Promise<void> {
    switch (delivery.kind) {
      case "message": {
        await this.#deliverMessage(delivery);
        break;
      }

      case "approval_requested": {
        await this.#deliverApprovalRequest(delivery);
        break;
      }

      case "approval_resolved": {
        await this.#deliverApprovalResolved(delivery);
        break;
      }

      default: {
        // A Delivery kind from a newer SDK. A retry cannot teach this binding to deliver it.
        const unknownDelivery: { readonly kind: string } = delivery;

        throw new DeliveryError(
          `The Discord binding cannot deliver ${unknownDelivery.kind}`,
          { kind: "permanent" }
        );
      }
    }
  }

  async #deliverMessage(delivery: MessageDelivery): Promise<void> {
    const channel = await this.#resolveChannel(delivery.chatId);

    const files = toUploadPayloads(
      delivery.attachments ?? [],
      this.#ctx.maxAttachmentBytes
    );

    const payloads = outboundPayloads(delivery.text, files);

    const draft =
      delivery.runId === undefined
        ? undefined
        : await this.#live.finalize(delivery.runId);

    const [first, ...rest] = payloads;

    if (draft !== undefined && first === undefined) {
      await draft.delete();

      return;
    }

    if (draft !== undefined && first !== undefined) {
      await draft.edit(first);
    }

    for (const payload of draft === undefined ? payloads : rest) {
      // oxlint-disable-next-line no-await-in-loop -- Chunks must arrive in order.
      await channel.send(payload);
    }
  }

  async #deliverApprovalRequest(
    delivery: ApprovalRequestedDelivery
  ): Promise<void> {
    const { discord } = this.#requireConnection();
    const channel = await this.#resolveChannel(delivery.chatId);

    if (this.#prompts.get(delivery.approvalId) !== undefined) {
      return;
    }

    const key = promptKey(delivery.approvalId);
    const content = promptContent(delivery);

    const message = await channel.send({
      allowedMentions: NO_MENTIONS,
      components: [approvalButtons(discord, key, false)],
      content,
    });

    await this.#prompts.put({
      approvalId: delivery.approvalId,
      channelId: channel.id,
      content,
      key,
      messageId: message.id,
    });
  }

  async #deliverApprovalResolved(
    delivery: ApprovalResolvedDelivery
  ): Promise<void> {
    const { discord } = this.#requireConnection();
    const record = this.#prompts.get(delivery.approvalId);

    if (record === undefined) {
      this.#ctx.log.warn(
        "No Discord prompt is stored for a resolved Approval",
        {
          approvalId: delivery.approvalId,
          chatId: delivery.chatId,
        }
      );

      return;
    }

    const channel = await this.#resolveChannel(record.channelId);

    try {
      await channel.messages.edit(record.messageId, {
        components: [approvalButtons(discord, record.key, true)],
        content: resolvedContent(
          record.content,
          delivery.decision,
          delivery.resolvedBy,
          delivery.reason
        ),
      });
    } catch (error) {
      if (discordErrorCode(error) !== UNKNOWN_MESSAGE_CODE) {
        throw error;
      }
    }

    await this.#prompts.delete(delivery.approvalId);
  }
}
