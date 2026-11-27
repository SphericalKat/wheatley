import type {
  ApprovalDecision,
  ApprovalOutcome,
  ApprovalRequestedDelivery,
  ApprovalResolvedDelivery,
} from "@wheatley-ai/sdk";
import { Type } from "typebox";
import type { Static } from "typebox";

import type { InlineButton } from "./client.js";
import { escapeHtml } from "./markdown.js";
import { shortToken, TokenStore } from "./token-store.js";

const STORE_FILE = "approvals.json";
const CALLBACK_PREFIX = "ap";
const CALLBACK_DATA = /^ap:(?<token>[\w-]+):(?<code>[ocad])$/u;

/** The four buttons of an Approval prompt, in display order, with their callback codes. */
const BUTTONS = [
  { code: "o", decision: "allow_once", label: "Allow once" },
  { code: "c", decision: "allow_conversation", label: "Allow for chat" },
  { code: "a", decision: "allow_always", label: "Always allow" },
  { code: "d", decision: "deny", label: "Deny" },
] as const satisfies readonly {
  readonly code: string;
  readonly decision: ApprovalDecision;
  readonly label: string;
}[];

const OUTCOME_TEXT: Readonly<Record<ApprovalOutcome, string>> = {
  allow_always: "Always allowed",
  allow_conversation: "Allowed for this conversation",
  allow_once: "Allowed once",
  cancelled: "Cancelled",
  deny: "Denied",
  timeout: "Timed out",
};

const PromptSchema = Type.Object({
  approvalId: Type.String(),
  chatId: Type.String(),
  inputPreview: Type.String(),
  messageId: Type.Number(),
  telegramChatId: Type.Number(),
  toolName: Type.String(),
});

/** The Telegram message that shows one pending Approval. */
export type ApprovalPrompt = Static<typeof PromptSchema>;

/** Returns the short key of an Approval for callback data, which Telegram limits to 64 bytes. */
export const approvalToken = (approvalId: string): string =>
  shortToken(approvalId);

/** The inline keyboard of an Approval prompt: two rows of two buttons. */
export const approvalKeyboard = (
  approvalId: string
): readonly (readonly InlineButton[])[] => {
  const token = approvalToken(approvalId);

  const buttons = BUTTONS.map((button) => ({
    callbackData: `${CALLBACK_PREFIX}:${token}:${button.code}`,
    text: button.label,
  }));

  return [buttons.slice(0, 2), buttons.slice(2)];
};

/** Parses the callback data of an Approval button. Returns `undefined` for other callback data. */
export const parseApprovalCallback = (
  data: string
):
  | { readonly token: string; readonly decision: ApprovalDecision }
  | undefined => {
  const groups = CALLBACK_DATA.exec(data)?.groups;
  const button = BUTTONS.find((entry) => entry.code === groups?.code);

  return groups?.token === undefined || button === undefined
    ? undefined
    : { decision: button.decision, token: groups.token };
};

const describeTool = (toolName: string, inputPreview: string): string =>
  `Tool: <code>${escapeHtml(toolName)}</code>\n<pre>${escapeHtml(inputPreview)}</pre>`;

/** The HTML text of an Approval prompt. */
export const approvalRequestText = (
  delivery: ApprovalRequestedDelivery
): string => {
  const expiry =
    delivery.expiresAt === null
      ? ""
      : `\nExpires: ${escapeHtml(delivery.expiresAt)}`;

  return `<b>Approval needed</b>\n${describeTool(delivery.toolName, delivery.inputPreview)}${expiry}`;
};

/** The HTML text that replaces an Approval prompt when the Approval ends. */
export const approvalResolvedText = (
  delivery: ApprovalResolvedDelivery,
  prompt: Pick<ApprovalPrompt, "toolName" | "inputPreview"> | undefined
): string => {
  const by =
    delivery.resolvedBy === undefined
      ? ""
      : ` by ${escapeHtml(delivery.resolvedBy)}`;

  const reason =
    delivery.reason === undefined
      ? ""
      : `\nReason: ${escapeHtml(delivery.reason)}`;

  const tool =
    prompt === undefined
      ? ""
      : `\n${describeTool(prompt.toolName, prompt.inputPreview)}`;

  return `<b>${OUTCOME_TEXT[delivery.decision]}</b>${by}${tool}${reason}`;
};

/**
 * The Approval prompts of one binding, kept in `approvals.json` of the binding's data directory so that an Approval
 * that ends after a restart still edits its prompt.
 */
export class ApprovalPromptStore {
  readonly #store: TokenStore<typeof PromptSchema>;

  constructor(dataDir: string) {
    this.#store = new TokenStore({
      dataDir,
      file: STORE_FILE,
      schema: PromptSchema,
    });
  }

  /** Reads the file. A missing file is an empty store. Rejects if the file is not a valid store. */
  readonly load = async (): Promise<void> => {
    await this.#store.load();
  };

  /** Returns the prompt of an Approval by its callback token. */
  readonly byToken = (token: string): ApprovalPrompt | undefined =>
    this.#store.get(token);

  /** Returns the prompt of an Approval. */
  readonly get = (approvalId: string): ApprovalPrompt | undefined =>
    this.#store.get(approvalToken(approvalId));

  /** Stores a prompt. Resolves once the file is written. */
  readonly put = async (prompt: ApprovalPrompt): Promise<void> => {
    await this.#store.put(approvalToken(prompt.approvalId), prompt);
  };

  /** Removes a prompt. Resolves once the file is written. */
  readonly delete = async (approvalId: string): Promise<void> => {
    await this.#store.delete(approvalToken(approvalId));
  };
}
