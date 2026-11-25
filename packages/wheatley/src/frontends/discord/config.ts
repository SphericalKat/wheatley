import type { JsonObject, JsonSchema, JsonValue } from "@wheatley-ai/sdk";

const GUILD_MESSAGE_MODES = ["mention_or_reply", "all"] as const;
const STREAMING_MODES = ["edit", "typing"] as const;

/** How the binding treats messages in guild channels and guild threads. DMs always reach the Agent. */
export type GuildMessageMode = (typeof GUILD_MESSAGE_MODES)[number];

/** How the binding shows live Run progress: a typing indicator plus a draft message that it edits, or typing only. */
export type StreamingMode = (typeof STREAMING_MODES)[number];

/** The validated settings of one Discord Frontend Binding. */
export interface DiscordConfig {
  /** The name of the `secrets.yaml` entry that holds the bot token. */
  readonly tokenSecret: string;
  /**
   * Channel IDs (DM, guild channel, or thread) that can reach the Agent. A thread is allowed if its own ID or the ID of
   * its parent channel is in the list.
   */
  readonly allowedChatIds: readonly string[];
  readonly guildMessages: GuildMessageMode;
  readonly streaming: StreamingMode;
  /** The minimum time between two edits of a draft message. */
  readonly editIntervalMs: number;
  /** Guilds for instant Slash Command registration. If empty, the binding registers global commands. */
  readonly commandGuildIds: readonly string[];
}

/** The default minimum time between two draft edits (ADR 0012). */
export const DEFAULT_EDIT_INTERVAL_MS = 1200;

/** Discord rejects edits faster than this rate for one channel, so smaller intervals only cause rate limits. */
const MIN_EDIT_INTERVAL_MS = 250;

const MAX_EDIT_INTERVAL_MS = 60_000;

const SNOWFLAKE_PATTERN = "^[0-9]{1,25}$";
const SNOWFLAKE = /^[0-9]{1,25}$/u;

const snowflakeList = (minItems: number): JsonObject => ({
  items: { pattern: SNOWFLAKE_PATTERN, type: "string" },
  minItems,
  type: "array",
  uniqueItems: true,
});

const configProperties: JsonObject = {
  allowedChatIds: snowflakeList(1),
  commandGuildIds: snowflakeList(0),
  editIntervalMs: {
    maximum: MAX_EDIT_INTERVAL_MS,
    minimum: MIN_EDIT_INTERVAL_MS,
    type: "integer",
  },
  guildMessages: { enum: [...GUILD_MESSAGE_MODES], type: "string" },
  streaming: { enum: [...STREAMING_MODES], type: "string" },
  tokenSecret: { minLength: 1, type: "string" },
};

/** The plain JSON Schema of the `config` object of a `type: discord` Frontend Binding. */
export const discordConfigSchema: JsonSchema = {
  additionalProperties: false,
  properties: configProperties,
  required: ["tokenSecret", "allowedChatIds"],
  type: "object",
};

const KNOWN_KEYS: ReadonlySet<string> = new Set(Object.keys(configProperties));

const isJsonObject = (value: JsonValue | undefined): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isString = (value: JsonValue | undefined): value is string =>
  typeof value === "string";

const isInteger = (value: JsonValue | undefined): value is number =>
  typeof value === "number" && Number.isInteger(value);

const isJsonArray = (
  value: JsonValue | undefined
): value is readonly JsonValue[] => Array.isArray(value);

const invalid = (message: string): Error =>
  new Error(`Invalid Discord Frontend config: ${message}`);

const readSnowflakes = (
  value: JsonValue | undefined,
  key: string,
  minItems: number
): readonly string[] => {
  if (value === undefined && minItems === 0) {
    return [];
  }

  if (!isJsonArray(value)) {
    throw invalid(`${key} must be an array of Discord IDs`);
  }

  const ids: string[] = [];

  for (const item of value) {
    if (!isString(item) || !SNOWFLAKE.test(item)) {
      throw invalid(`${key} must contain only Discord IDs (digits)`);
    }

    ids.push(item);
  }

  if (ids.length < minItems) {
    throw invalid(`${key} must list at least ${minItems} ID`);
  }

  return [...new Set(ids)];
};

const readEnum = <T extends string>(
  value: JsonValue | undefined,
  key: string,
  allowed: readonly T[],
  fallback: T
): T => {
  if (value === undefined) {
    return fallback;
  }

  const match = allowed.find((option) => option === value);

  if (match === undefined) {
    throw invalid(`${key} must be one of ${allowed.join(", ")}`);
  }

  return match;
};

const readEditInterval = (value: JsonValue | undefined): number => {
  if (value === undefined) {
    return DEFAULT_EDIT_INTERVAL_MS;
  }

  const inRange =
    isInteger(value) &&
    value >= MIN_EDIT_INTERVAL_MS &&
    value <= MAX_EDIT_INTERVAL_MS;

  if (!inRange) {
    throw invalid(
      `editIntervalMs must be an integer from ${MIN_EDIT_INTERVAL_MS} to ${MAX_EDIT_INTERVAL_MS}`
    );
  }

  return value;
};

/**
 * Converts a binding `config` value into `DiscordConfig` and applies the defaults.
 *
 * Throws an `Error` that names the first invalid field, for example an empty `allowedChatIds` list (ADR 0012).
 */
export const parseDiscordConfig = (value: JsonValue): DiscordConfig => {
  if (!isJsonObject(value)) {
    throw invalid("config must be an object");
  }

  const unknownKey = Object.keys(value).find((key) => !KNOWN_KEYS.has(key));

  if (unknownKey !== undefined) {
    throw invalid(`unknown field ${unknownKey}`);
  }

  const { tokenSecret } = value;

  if (!isString(tokenSecret) || tokenSecret === "") {
    throw invalid("tokenSecret must name a secret");
  }

  return {
    allowedChatIds: readSnowflakes(value.allowedChatIds, "allowedChatIds", 1),
    commandGuildIds: readSnowflakes(
      value.commandGuildIds,
      "commandGuildIds",
      0
    ),
    editIntervalMs: readEditInterval(value.editIntervalMs),
    guildMessages: readEnum(
      value.guildMessages,
      "guildMessages",
      GUILD_MESSAGE_MODES,
      "mention_or_reply"
    ),
    streaming: readEnum(value.streaming, "streaming", STREAMING_MODES, "edit"),
    tokenSecret,
  };
};
