import type { Attachment, Delivery } from "@wheatley-ai/sdk";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

/** An attachment as the outbox stores it: bytes become base64 text, so the whole `Delivery` fits in one JSON column. */
const StoredAttachmentSchema = Type.Union([
  Type.Object({
    base64: Type.String(),
    filename: Type.String(),
    kind: Type.Literal("bytes"),
    mimeType: Type.String(),
  }),
  Type.Object({
    filename: Type.String(),
    kind: Type.Literal("file"),
    mimeType: Type.String(),
    path: Type.String(),
    sizeBytes: Type.Number(),
  }),
]);

type StoredAttachment = Static<typeof StoredAttachmentSchema>;

const StoredDeliverySchema = Type.Union([
  Type.Object({
    attachments: Type.Optional(Type.Array(StoredAttachmentSchema)),
    chatId: Type.String(),
    kind: Type.Literal("message"),
    messageId: Type.String(),
    runId: Type.Optional(Type.String()),
    source: Type.Union([
      Type.Literal("reply"),
      Type.Literal("command"),
      Type.Literal("trigger"),
    ]),
    text: Type.String(),
  }),
  Type.Object({
    approvalId: Type.String(),
    chatId: Type.String(),
    expiresAt: Type.Union([Type.String(), Type.Null()]),
    inputPreview: Type.String(),
    kind: Type.Literal("approval_requested"),
    messageId: Type.String(),
    runId: Type.String(),
    toolName: Type.String(),
  }),
  Type.Object({
    approvalId: Type.String(),
    chatId: Type.String(),
    decision: Type.Union([
      Type.Literal("allow_once"),
      Type.Literal("allow_conversation"),
      Type.Literal("allow_always"),
      Type.Literal("deny"),
      Type.Literal("timeout"),
      Type.Literal("cancelled"),
    ]),
    kind: Type.Literal("approval_resolved"),
    messageId: Type.String(),
    reason: Type.Optional(Type.String()),
    resolvedBy: Type.Optional(Type.String()),
  }),
]);

const storeAttachment = (attachment: Attachment): StoredAttachment =>
  attachment.kind === "bytes"
    ? {
        base64: Buffer.from(attachment.data).toString("base64"),
        filename: attachment.filename,
        kind: "bytes",
        mimeType: attachment.mimeType,
      }
    : attachment;

const loadAttachment = (stored: StoredAttachment): Attachment =>
  stored.kind === "bytes"
    ? {
        data: new Uint8Array(Buffer.from(stored.base64, "base64")),
        filename: stored.filename,
        kind: "bytes",
        mimeType: stored.mimeType,
      }
    : stored;

/** Serializes a `Delivery` for the outbox. Attachment bytes round-trip through base64. */
export const encodeDelivery = (delivery: Delivery): string => {
  if (delivery.kind !== "message" || delivery.attachments === undefined) {
    return JSON.stringify(delivery);
  }

  return JSON.stringify({
    ...delivery,
    attachments: delivery.attachments.map(storeAttachment),
  });
};

/** Parses a `Delivery` that `encodeDelivery` stored. Throws a `TypeError` for any other text. */
export const decodeDelivery = (json: string): Delivery => {
  const value: unknown = JSON.parse(json);

  if (!Value.Check(StoredDeliverySchema, value)) {
    throw new TypeError("Stored delivery is invalid");
  }

  if (value.kind !== "message") {
    return value;
  }

  const { attachments, ...message } = value;

  return attachments === undefined
    ? message
    : { ...message, attachments: attachments.map(loadAttachment) };
};
