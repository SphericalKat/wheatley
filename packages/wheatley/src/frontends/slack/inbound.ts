import type { ApprovalDecision, JsonValue } from "@wheatley-ai/sdk";

import { decisionOfAction } from "./approval-blocks.js";
import { MODEL_ACTION_PREFIX } from "./model-picker-blocks.js";
import type { BlockActions } from "./schemas.js";
import {
  BlockActionsSchema,
  decodeOptional,
  MessageEventCallbackSchema,
  SlashCommandSchema,
} from "./schemas.js";

/** A file that a Slack message shares. */
export interface SlackFile {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  /** The size that Slack reports, if any. */
  readonly sizeBytes: number | undefined;
  /** `url_private_download`, which needs the bot token. Absent for external files. */
  readonly url: string | undefined;
}

/** A Sender message from the Events API. */
export interface SlackMessage {
  /** The Events API `event_id`, for duplicate detection of retried events. */
  readonly eventId: string | undefined;
  readonly channel: string;
  /** `im` for a DM. `channel`, `group`, or `mpim` otherwise. */
  readonly channelType: string | undefined;
  readonly user: string;
  readonly text: string;
  readonly ts: string;
  readonly threadTs: string | undefined;
  readonly parentUserId: string | undefined;
  readonly files: readonly SlackFile[];
}

/** A Slash Command invocation. */
export interface SlackSlashCommand {
  /** The command with its slash, for example `/new`. */
  readonly command: string;
  readonly text: string;
  readonly channel: string;
  readonly user: string;
  readonly userName: string | undefined;
}

/** A click on an Approval button. */
export interface SlackApprovalAction {
  readonly kind: "approval";
  readonly approvalId: string;
  readonly decision: ApprovalDecision;
  readonly channel: string;
  readonly threadTs: string | undefined;
  readonly user: string;
  readonly userName: string | undefined;
}

/** A selection in a model picker menu. */
export interface SlackModelSelection {
  readonly kind: "model";
  /** The `/model` argument: `<provider>/<id>`. */
  readonly model: string;
  readonly channel: string;
  readonly threadTs: string | undefined;
  /** The `ts` of the picker message, for the update after the selection. */
  readonly messageTs: string | undefined;
  readonly user: string;
  readonly userName: string | undefined;
}

/** A Block Kit interaction that the binding handles. */
export type SlackInteraction = SlackApprovalAction | SlackModelSelection;

/** Message subtypes that carry a Sender message. Other subtypes are edits, joins, bot posts, and similar. */
const USER_SUBTYPES: ReadonlySet<string | undefined> = new Set([
  undefined,
  "file_share",
  "thread_broadcast",
]);

const DEFAULT_MIME_TYPE = "application/octet-stream";

/**
 * Parses an Events API `event_callback` payload. Returns `undefined` for anything other than a Sender message: other
 * event types, bot messages, edits, and malformed payloads.
 */
export const parseEventCallback = (
  payload: JsonValue | undefined
): SlackMessage | undefined => {
  const decoded = decodeOptional(MessageEventCallbackSchema, payload);

  if (decoded === undefined) {
    return undefined;
  }

  const { event } = decoded;

  if (!USER_SUBTYPES.has(event.subtype) || event.bot_id !== undefined) {
    return undefined;
  }

  return {
    channel: event.channel,
    channelType: event.channel_type,
    eventId: decoded.event_id,
    files: (event.files ?? []).map((file) => ({
      id: file.id,
      mimeType: file.mimetype ?? DEFAULT_MIME_TYPE,
      name: file.name ?? file.id,
      sizeBytes: file.size,
      url: file.url_private_download,
    })),
    parentUserId: event.parent_user_id,
    text: event.text ?? "",
    threadTs: event.thread_ts,
    ts: event.ts,
    user: event.user,
  };
};

/** Parses a Slash Command payload from Socket Mode or from the form fields of a webhook request. */
export const parseSlashCommand = (
  payload: JsonValue | undefined
): SlackSlashCommand | undefined => {
  const decoded = decodeOptional(SlashCommandSchema, payload);

  return decoded === undefined
    ? undefined
    : {
        channel: decoded.channel_id,
        command: decoded.command,
        text: decoded.text ?? "",
        user: decoded.user_id,
        userName: decoded.user_name,
      };
};

type BlockAction = BlockActions["actions"][number];

/** Who acted, and in which Chat, for an interaction. */
type InteractionSender = Omit<
  SlackApprovalAction,
  "kind" | "approvalId" | "decision"
>;

/** Returns the model selection or Approval click of one action, or `undefined` for another action. */
const interactionOf = (
  action: BlockAction,
  sender: InteractionSender,
  messageTs: string | undefined
): SlackInteraction | undefined => {
  const model = action.selected_option?.value;

  if (action.action_id.startsWith(MODEL_ACTION_PREFIX) && model !== undefined) {
    return { ...sender, kind: "model", messageTs, model };
  }

  const decision = decisionOfAction(action.action_id);
  const approvalId = action.value;

  return decision === undefined || approvalId === undefined
    ? undefined
    : { ...sender, approvalId, decision, kind: "approval" };
};

/**
 * Parses a `block_actions` payload. Returns `undefined` unless the first action is an Approval button or a model picker
 * selection.
 */
export const parseInteraction = (
  payload: JsonValue | undefined
): SlackInteraction | undefined => {
  const decoded = decodeOptional(BlockActionsSchema, payload);
  const [action] = decoded?.actions ?? [];
  const channel = decoded?.channel?.id ?? decoded?.container?.channel_id;

  if (decoded === undefined || action === undefined || channel === undefined) {
    return undefined;
  }

  const sender = {
    channel,
    threadTs: decoded.message?.thread_ts,
    user: decoded.user.id,
    userName: decoded.user.name ?? decoded.user.username,
  };

  return interactionOf(
    action,
    sender,
    decoded.message?.ts ?? decoded.container?.message_ts
  );
};
