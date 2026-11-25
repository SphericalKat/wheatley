import type { ChatUpdateArguments } from "@slack/web-api";
import type {
  ApprovalDecision,
  ApprovalOutcome,
  ApprovalRequestedDelivery,
  ApprovalResolvedDelivery,
} from "@wheatley/sdk";

/** Block Kit blocks, as `chat.postMessage` and `chat.update` accept them. */
export type SlackBlocks = Extract<
  ChatUpdateArguments,
  { blocks: unknown }
>["blocks"];

/** The `action_id` prefix of the Approval buttons. The decision follows the prefix. */
export const APPROVAL_ACTION_PREFIX = "wheatley_approval:";

/** The Approval details that the binding keeps to update the prompt when the Approval ends. */
export interface ApprovalPrompt {
  readonly toolName: string;
  readonly inputPreview: string;
}

const BUTTONS: readonly {
  readonly decision: ApprovalDecision;
  readonly label: string;
  readonly style?: "primary" | "danger";
}[] = [
  { decision: "allow_once", label: "Allow once", style: "primary" },
  { decision: "allow_conversation", label: "Allow for Conversation" },
  { decision: "allow_always", label: "Always allow" },
  { decision: "deny", label: "Deny", style: "danger" },
];

const OUTCOME_LABELS: Readonly<Record<ApprovalOutcome, string>> = {
  allow_always: "Always allowed",
  allow_conversation: "Allowed for this Conversation",
  allow_once: "Allowed once",
  cancelled: "Cancelled",
  deny: "Denied",
  timeout: "Timed out",
};

const OUTCOME_ICONS: Readonly<Record<ApprovalOutcome, string>> = {
  allow_always: ":white_check_mark:",
  allow_conversation: ":white_check_mark:",
  allow_once: ":white_check_mark:",
  cancelled: ":no_entry_sign:",
  deny: ":x:",
  timeout: ":hourglass:",
};

/** Escapes the three characters that Slack `mrkdwn` reserves. */
export const escapeMrkdwn = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** Slack shows a code block with three backticks. A preview that contains them must not end the block early. */
const codeBlock = (text: string): string =>
  `\`\`\`${escapeMrkdwn(text).replaceAll("```", "`​``")}\`\`\``;

const describeTool = (prompt: ApprovalPrompt): string =>
  `*Tool:* \`${escapeMrkdwn(prompt.toolName)}\`\n${codeBlock(prompt.inputPreview === "" ? " " : prompt.inputPreview)}`;

/** The fallback text of an Approval prompt, for notifications and clients without Block Kit. */
export const approvalRequestText = (prompt: ApprovalPrompt): string =>
  `Approval needed for ${prompt.toolName}`;

/** Builds the Block Kit prompt with the four decision buttons for an `approval_requested` delivery. */
export const approvalRequestBlocks = (
  delivery: ApprovalRequestedDelivery
): SlackBlocks => {
  const expiry =
    delivery.expiresAt === null
      ? "This request does not time out."
      : `This request times out at ${escapeMrkdwn(delivery.expiresAt)}.`;

  return [
    {
      text: {
        text: `:lock: *Approval needed*\n${describeTool(delivery)}`,
        type: "mrkdwn",
      },
      type: "section",
    },
    {
      block_id: `approval:${delivery.approvalId}`,
      elements: BUTTONS.map((button) => ({
        action_id: `${APPROVAL_ACTION_PREFIX}${button.decision}`,
        // JSON serialization drops an undefined style, which gives the default button style.
        style: button.style,
        text: { text: button.label, type: "plain_text" },
        type: "button",
        value: delivery.approvalId,
      })),
      type: "actions",
    },
    { elements: [{ text: expiry, type: "mrkdwn" }], type: "context" },
  ];
};

/** The fallback text of a resolved Approval prompt. */
export const approvalResolvedText = (
  prompt: ApprovalPrompt,
  delivery: ApprovalResolvedDelivery
): string => `${OUTCOME_LABELS[delivery.decision]}: ${prompt.toolName}`;

/** Builds the Block Kit message that replaces the prompt when the Approval ends. It has no buttons. */
export const approvalResolvedBlocks = (
  prompt: ApprovalPrompt,
  delivery: ApprovalResolvedDelivery
): SlackBlocks => {
  const by =
    delivery.resolvedBy === undefined
      ? ""
      : ` by ${escapeMrkdwn(delivery.resolvedBy)}`;

  const reason =
    delivery.reason === undefined
      ? ""
      : `\n*Reason:* ${escapeMrkdwn(delivery.reason)}`;

  return [
    {
      text: {
        text: `${OUTCOME_ICONS[delivery.decision]} *${OUTCOME_LABELS[delivery.decision]}*${by}\n${describeTool(prompt)}${reason}`,
        type: "mrkdwn",
      },
      type: "section",
    },
  ];
};

/** The text of an Approval outcome when the binding has no record of the prompt. */
export const approvalOutcomeText = (
  delivery: ApprovalResolvedDelivery
): string => {
  const by =
    delivery.resolvedBy === undefined ? "" : ` by ${delivery.resolvedBy}`;

  const reason =
    delivery.reason === undefined ? "" : ` Reason: ${delivery.reason}`;

  return `${OUTCOME_ICONS[delivery.decision]} Approval ${delivery.approvalId}: ${OUTCOME_LABELS[delivery.decision]}${by}.${reason}`;
};

/** Returns the decision of an Approval button `action_id`, or `undefined` for another action. */
export const decisionOfAction = (
  actionId: string
): ApprovalDecision | undefined => {
  if (!actionId.startsWith(APPROVAL_ACTION_PREFIX)) {
    return undefined;
  }

  const name = actionId.slice(APPROVAL_ACTION_PREFIX.length);

  return BUTTONS.find((button) => button.decision === name)?.decision;
};
