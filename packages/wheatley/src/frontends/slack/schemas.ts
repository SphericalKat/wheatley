import { decode, isJsonValue } from "@wheatley-ai/protocol";
import type { JsonObject, JsonValue } from "@wheatley-ai/sdk";
import { Type } from "typebox";
import type { Static, TSchema } from "typebox";

const NonEmpty = Type.String({ minLength: 1 });

const isJsonObject = (value: JsonValue): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Converts a TypeBox schema into the plain JSON Schema document that `@wheatley-ai/sdk` accepts. */
export const toJsonSchema = (schema: TSchema): JsonObject => {
  // TypeBox keeps its metadata in non-enumerable properties, which the clone drops.
  const document = structuredClone(schema);

  if (!isJsonValue(document) || !isJsonObject(document)) {
    throw new TypeError("A TypeBox schema must serialize to a JSON object");
  }

  return document;
};

/** Parses JSON text. Returns `undefined` for invalid JSON. */
export const parseJsonText = (text: string): JsonValue | undefined => {
  try {
    const parsed: unknown = JSON.parse(text);

    return isJsonValue(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

/** Decodes `value` against `schema`. Returns `undefined` if the value does not match. */
export const decodeOptional = <Schema extends TSchema>(
  schema: Schema,
  value: JsonValue | undefined
): Static<Schema> | undefined => {
  if (value === undefined) {
    return undefined;
  }

  const decoded = decode(schema, value);

  return decoded.ok ? decoded.value : undefined;
};

/** A file of a Slack message event. */
export const SlackFileSchema = Type.Object({
  id: NonEmpty,
  mimetype: Type.Optional(Type.String()),
  name: Type.Optional(Type.String()),
  size: Type.Optional(Type.Number()),
  url_private_download: Type.Optional(NonEmpty),
});

/** A `message` event from a user, inside an Events API `event_callback` payload. */
export const MessageEventCallbackSchema = Type.Object({
  event: Type.Object({
    bot_id: Type.Optional(Type.String()),
    channel: NonEmpty,
    channel_type: Type.Optional(Type.String()),
    files: Type.Optional(Type.Array(SlackFileSchema)),
    parent_user_id: Type.Optional(Type.String()),
    subtype: Type.Optional(Type.String()),
    text: Type.Optional(Type.String()),
    thread_ts: Type.Optional(NonEmpty),
    ts: NonEmpty,
    type: Type.Literal("message"),
    user: NonEmpty,
  }),
  event_id: Type.Optional(NonEmpty),
});

/** The Events API handshake when the Operator sets the request URL. */
export const UrlVerificationSchema = Type.Object({
  challenge: NonEmpty,
  type: Type.Literal("url_verification"),
});

/** A Slash Command payload from Socket Mode, or the form fields of a webhook request. */
export const SlashCommandSchema = Type.Object({
  channel_id: NonEmpty,
  command: NonEmpty,
  text: Type.Optional(Type.String()),
  user_id: NonEmpty,
  user_name: Type.Optional(Type.String()),
});

/** A `block_actions` interactivity payload. */
export const BlockActionsSchema = Type.Object({
  actions: Type.Array(
    Type.Object({ action_id: NonEmpty, value: Type.Optional(NonEmpty) }),
    { minItems: 1 }
  ),
  channel: Type.Optional(Type.Object({ id: NonEmpty })),
  container: Type.Optional(
    Type.Object({ channel_id: Type.Optional(NonEmpty) })
  ),
  message: Type.Optional(
    Type.Object({
      thread_ts: Type.Optional(NonEmpty),
      ts: Type.Optional(NonEmpty),
    })
  ),
  type: Type.Literal("block_actions"),
  user: Type.Object({
    id: NonEmpty,
    name: Type.Optional(Type.String()),
    username: Type.Optional(Type.String()),
  }),
});

/** The Slack message that shows one Approval prompt. */
export const ApprovalRecordSchema = Type.Object({
  channel: NonEmpty,
  chatId: NonEmpty,
  inputPreview: Type.String(),
  resolved: Type.Boolean(),
  toolName: Type.String(),
  ts: NonEmpty,
});

export type ApprovalRecord = Static<typeof ApprovalRecordSchema>;

/** The state file of one binding. */
export const StateFileSchema = Type.Object({
  approvals: Type.Record(Type.String(), ApprovalRecordSchema),
  threads: Type.Array(Type.String()),
});
