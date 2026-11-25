import { decode, SecretRefSchema } from "@wheatley/protocol";
import type { SecretRef } from "@wheatley/protocol";
import type { JsonSchema, JsonValue, SecretReader } from "@wheatley/sdk";
import { Type } from "typebox";
import type { Static } from "typebox";

import { toJsonSchema } from "./schemas.js";

/** The default interval between two draft edits of one streamed reply (ADR 0012). */
export const DEFAULT_EDIT_INTERVAL_MS = 1200;

/** The smallest draft edit interval. Slack rate-limits `chat.update` at about one call per second per channel. */
export const MIN_EDIT_INTERVAL_MS = 1000;

/** The reaction that shows a Run in progress on the message that started it. */
export const DEFAULT_TYPING_REACTION = "hourglass_flowing_sand";

/** How the binding receives Slack events. */
export type SlackTransport = "socket" | "webhook";

/** Which channel messages start a Run. DMs always do. */
export type ChannelTrigger = "mention-or-reply" | "all";

/** How the binding shows live Run progress. */
export type StreamingMode = "edit" | "typing";

const SlackConfigSchema = Type.Object(
  {
    /** Slack channel, DM, or thread IDs (`<channel_id>:<thread_ts>`). A channel ID also allows its threads. */
    allowedChatIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    /** The app-level token (`xapp-`). Socket Mode needs it. */
    appToken: Type.Optional(SecretRefSchema),
    /** The bot token (`xoxb-`). */
    botToken: SecretRefSchema,
    /** Which channel messages start a Run. The default is `mention-or-reply`. */
    channelTrigger: Type.Optional(
      Type.Union([Type.Literal("mention-or-reply"), Type.Literal("all")])
    ),
    /** The interval between draft edits. The default is 1,200 ms. */
    editIntervalMs: Type.Optional(
      Type.Integer({ minimum: MIN_EDIT_INTERVAL_MS })
    ),
    /** The signing secret. Events API webhook requests need it. */
    signingSecret: Type.Optional(SecretRefSchema),
    /** `edit` streams a draft reply. `typing` shows only the typing reaction. The default is `edit`. */
    streaming: Type.Optional(
      Type.Union([Type.Literal("edit"), Type.Literal("typing")])
    ),
    /** `socket` (the default) uses Socket Mode. `webhook` uses the Events API through the Webhook Ingress. */
    transport: Type.Optional(
      Type.Union([Type.Literal("socket"), Type.Literal("webhook")])
    ),
    /** The emoji name of the typing reaction, without colons. */
    typingReaction: Type.Optional(Type.String({ pattern: "^[a-z0-9_+'-]+$" })),
  },
  { additionalProperties: false }
);

type RawSlackConfig = Static<typeof SlackConfigSchema>;

/** The JSON Schema of the `config` block of a `type: slack` entry in `frontends` of `config.yaml`. */
export const SLACK_CONFIG_SCHEMA: JsonSchema = toJsonSchema(SlackConfigSchema);

/** A validated Slack binding config with secret values resolved. */
export interface SlackBindingConfig {
  readonly transport: SlackTransport;
  readonly botToken: string;
  /** Present in `socket` transport. */
  readonly appToken: string | undefined;
  /** Present in `webhook` transport. */
  readonly signingSecret: string | undefined;
  readonly allowedChatIds: ReadonlySet<string>;
  readonly channelTrigger: ChannelTrigger;
  readonly streaming: StreamingMode;
  readonly editIntervalMs: number;
  readonly typingReaction: string;
}

const fail = (message: string): never => {
  throw new Error(`Invalid Slack binding config: ${message}`);
};

const resolveSecret = (
  key: string,
  ref: SecretRef | undefined,
  secrets: SecretReader
): string | undefined => {
  if (ref === undefined) {
    return undefined;
  }

  const value = secrets.get(ref.secret);

  return value === undefined || value === ""
    ? fail(`${key} names the missing secret ${ref.secret}`)
    : value;
};

/** Applies the transport rules and defaults to a schema-valid config, and resolves its secrets. */
const toBindingConfig = (
  config: RawSlackConfig,
  secrets: SecretReader
): SlackBindingConfig => {
  const transport = config.transport ?? "socket";
  const appToken = resolveSecret("appToken", config.appToken, secrets);

  const signingSecret = resolveSecret(
    "signingSecret",
    config.signingSecret,
    secrets
  );

  if (transport === "socket" && appToken === undefined) {
    return fail("appToken is required in socket transport");
  }

  if (transport === "webhook" && signingSecret === undefined) {
    return fail("signingSecret is required in webhook transport");
  }

  return {
    allowedChatIds: new Set(config.allowedChatIds),
    appToken,
    botToken:
      resolveSecret("botToken", config.botToken, secrets) ??
      fail("botToken is required"),
    channelTrigger: config.channelTrigger ?? "mention-or-reply",
    editIntervalMs: config.editIntervalMs ?? DEFAULT_EDIT_INTERVAL_MS,
    signingSecret,
    streaming: config.streaming ?? "edit",
    transport,
    typingReaction: config.typingReaction ?? DEFAULT_TYPING_REACTION,
  };
};

/**
 * Validates a binding config and resolves its secrets.
 *
 * Throws an `Error` for a config that breaks `SLACK_CONFIG_SCHEMA` (for example an empty `allowedChatIds`), a missing
 * secret, a missing `appToken` in `socket` transport, or a missing `signingSecret` in `webhook` transport.
 */
export const parseSlackConfig = (
  raw: JsonValue,
  secrets: SecretReader
): SlackBindingConfig => {
  const decoded = decode(SlackConfigSchema, raw);

  if (!decoded.ok) {
    return fail(
      decoded.issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")
    );
  }

  return toBindingConfig(decoded.value, secrets);
};
