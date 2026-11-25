import type {
  JsonValue,
  StandardJsonSchemaDocument,
  StandardJsonSchemaV1,
} from "@wheatley/sdk";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

import { ALLOWLIST_ENTRY } from "./chat-key.js";

/** The default interval between two draft edits (ADR 0012). */
export const DEFAULT_DRAFT_INTERVAL_MS = 1200;

/** Telegram rate limits make shorter draft intervals fail with HTTP 429. */
const MIN_DRAFT_INTERVAL_MS = 500;

const HTTPS_URL = "^https://\\S+$";

const strict = { additionalProperties: false } as const;

/** The `config` of one Telegram Frontend Binding in `config.yaml`, before defaults. */
export const TelegramConfigSchema = Type.Object(
  {
    /** The Telegram Chats that the binding serves: a user, group, or supergroup ID, or a `<chat_id>:topic:<thread_id>` key. */
    allowedChatIds: Type.Array(
      Type.Union([
        Type.Integer(),
        Type.String({ pattern: ALLOWLIST_ENTRY.source }),
      ]),
      { minItems: 1 }
    ),
    /** The secret in `secrets.yaml` that holds the bot token from BotFather. */
    botToken: Type.Object({ secret: Type.String({ minLength: 1 }) }, strict),
    /** The interval between two draft edits in milliseconds. The default is 1200. */
    draftIntervalMs: Type.Optional(
      Type.Integer({ minimum: MIN_DRAFT_INTERVAL_MS })
    ),
    /** `mention` (default): in groups, answer only messages that mention the bot or reply to it. */
    groupActivation: Type.Optional(
      Type.Union([Type.Literal("mention"), Type.Literal("always")])
    ),
    /** `polling` (default) uses outbound long polling. `webhook` mounts a route on the Webhook Ingress. */
    mode: Type.Optional(
      Type.Union([Type.Literal("polling"), Type.Literal("webhook")])
    ),
    /** `draft` (default) streams the reply into an edited message. `typing` shows only the typing indicator. */
    streaming: Type.Optional(
      Type.Union([Type.Literal("draft"), Type.Literal("typing")])
    ),
    /**
     * The public HTTPS URL that Telegram calls in webhook mode. The reverse proxy must forward it to the route
     * `/frontends/<agent>/<binding-id>/updates` of the Webhook Ingress.
     */
    webhookUrl: Type.Optional(Type.String({ pattern: HTTPS_URL })),
  },
  strict
);

type RawTelegramConfig = Static<typeof TelegramConfigSchema>;

/** The validated config of one Telegram Frontend Binding, with defaults applied. */
export interface TelegramConfig {
  /** Normalized to strings. */
  readonly allowedChatIds: readonly string[];
  readonly botTokenSecret: string;
  readonly draftIntervalMs: number;
  readonly groupActivation: "mention" | "always";
  readonly transport:
    | { readonly mode: "polling" }
    | { readonly mode: "webhook"; readonly url: string };
  readonly streaming: "draft" | "typing";
}

/** One problem of a binding config. `path` names the property, for example `["allowedChatIds"]`. */
export interface ConfigIssue {
  readonly message: string;
  readonly path: readonly string[];
}

/** The result of `validateTelegramConfig`. */
export type ConfigResult =
  | { readonly value: TelegramConfig; readonly issues?: undefined }
  | { readonly issues: readonly ConfigIssue[] };

const issuesOf = (value: JsonValue): ConfigIssue[] =>
  Value.Errors(TelegramConfigSchema, value).map((error) => ({
    message: error.message,
    path: error.instancePath.split("/").filter((part) => part !== ""),
  }));

const normalize = (raw: RawTelegramConfig): ConfigResult => {
  const mode = raw.mode ?? "polling";

  if (mode === "webhook" && raw.webhookUrl === undefined) {
    return {
      issues: [
        {
          message: "webhookUrl is required when mode is webhook",
          path: ["webhookUrl"],
        },
      ],
    };
  }

  return {
    value: {
      allowedChatIds: raw.allowedChatIds.map(String),
      botTokenSecret: raw.botToken.secret,
      draftIntervalMs: raw.draftIntervalMs ?? DEFAULT_DRAFT_INTERVAL_MS,
      groupActivation: raw.groupActivation ?? "mention",
      streaming: raw.streaming ?? "draft",
      transport:
        mode === "webhook" && raw.webhookUrl !== undefined
          ? { mode, url: raw.webhookUrl }
          : { mode: "polling" },
    },
  };
};

/**
 * Validates and normalizes a Telegram binding config.
 *
 * Returns the issues for a value that breaks `TelegramConfigSchema`, or for webhook mode without `webhookUrl`.
 */
export const validateTelegramConfig = (value: JsonValue): ConfigResult =>
  Value.Check(TelegramConfigSchema, value)
    ? normalize(value)
    : { issues: issuesOf(value) };

const jsonSchemaDocument = (): StandardJsonSchemaDocument => ({
  ...structuredClone(TelegramConfigSchema),
});

/** Formats validation issues for an error message. */
export const formatIssues = (issues: readonly ConfigIssue[]): string =>
  issues
    .map((issue) => `/${issue.path.join("/")}: ${issue.message}`)
    .join("; ");

/**
 * The `configSchema` of the Telegram Frontend, as Standard JSON Schema V1 with a validator. The validator accepts the
 * input unchanged, because `Frontend.createBinding` takes JSON config and normalizes it with `validateTelegramConfig`.
 */
export const telegramConfigSchema: StandardJsonSchemaV1 = {
  "~standard": {
    jsonSchema: { input: jsonSchemaDocument, output: jsonSchemaDocument },
    validate: (value) => {
      const result = validateTelegramConfig(value);

      return result.issues === undefined
        ? { value }
        : { issues: result.issues };
    },
    vendor: "wheatley",
    version: 1,
  },
};
