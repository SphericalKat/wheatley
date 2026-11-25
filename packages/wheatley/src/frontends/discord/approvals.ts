import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  ApprovalDecision,
  ApprovalOutcome,
  ApprovalRequestedDelivery,
} from "@wheatley/sdk";
import type * as DiscordJs from "discord.js";

import type { DiscordRuntime } from "./discord-runtime.js";

/** Discord limits a component `custom_id` to this many characters. */
const MAX_CUSTOM_ID_LENGTH = 100;
const CUSTOM_ID_PREFIX = "wheatley-approval";
const HASHED_KEY_MARKER = "#";
const HASHED_KEY_LENGTH = 40;
const MS_PER_SECOND = 1000;
const STORE_FILE = "approval-prompts.json";
const STORE_VERSION = 1;

const DECISION_CODES = {
  allow_always: "a",
  allow_conversation: "c",
  allow_once: "o",
  deny: "d",
} as const satisfies Record<ApprovalDecision, string>;

const BUTTON_ORDER: readonly ApprovalDecision[] = [
  "allow_once",
  "allow_conversation",
  "allow_always",
  "deny",
];

const BUTTON_LABELS: Readonly<Record<ApprovalDecision, string>> = {
  allow_always: "Always allow",
  allow_conversation: "Allow in Conversation",
  allow_once: "Allow once",
  deny: "Deny",
};

const OUTCOME_TEXT: Readonly<Record<ApprovalOutcome, string>> = {
  allow_always: "Always allowed",
  allow_conversation: "Allowed for this Conversation",
  allow_once: "Allowed once",
  cancelled: "Cancelled",
  deny: "Denied",
  timeout: "Timed out",
};

/** The platform message that shows one Approval prompt. */
export interface PromptRecord {
  readonly approvalId: string;
  /** The key in the button `custom_id`: the Approval ID, or a hash of it if the ID is too long. */
  readonly key: string;
  readonly channelId: string;
  readonly messageId: string;
  /** The prompt text without the outcome line. */
  readonly content: string;
}

/** A button press on an Approval prompt. */
export interface ApprovalPress {
  readonly key: string;
  readonly decision: ApprovalDecision;
}

/** A `custom_id` is `<prefix>:<decision code>:<key>`: two separators and a one-character decision code. */
const CUSTOM_ID_OVERHEAD = ":".length * 2 + 1;

const longestKey =
  MAX_CUSTOM_ID_LENGTH - CUSTOM_ID_PREFIX.length - CUSTOM_ID_OVERHEAD;

/** Returns the `custom_id` key for an Approval ID. IDs that do not fit in a `custom_id` become a hash. */
export const promptKey = (approvalId: string): string =>
  approvalId.length <= longestKey && !approvalId.startsWith(HASHED_KEY_MARKER)
    ? approvalId
    : `${HASHED_KEY_MARKER}${createHash("sha256").update(approvalId).digest("base64url").slice(0, HASHED_KEY_LENGTH)}`;

const customId = (key: string, decision: ApprovalDecision): string =>
  `${CUSTOM_ID_PREFIX}:${DECISION_CODES[decision]}:${key}`;

/** Parses the `custom_id` of an Approval button, or returns `undefined` for other components. */
export const parseApprovalCustomId = (
  value: string
): ApprovalPress | undefined => {
  const [prefix, code, ...rest] = value.split(":");
  const key = rest.join(":");

  const decision = BUTTON_ORDER.find(
    (candidate) => DECISION_CODES[candidate] === code
  );

  if (prefix !== CUSTOM_ID_PREFIX || decision === undefined || key === "") {
    return undefined;
  }

  return { decision, key };
};

const FENCE = /```/gu;

/** Builds the prompt text of an `approval_requested` delivery. */
export const promptContent = (delivery: ApprovalRequestedDelivery): string => {
  const preview = delivery.inputPreview.replaceAll(FENCE, "`​``");

  const expiry =
    delivery.expiresAt === null
      ? "This request does not time out."
      : `This request times out <t:${Math.floor(Date.parse(delivery.expiresAt) / MS_PER_SECOND)}:R>.`;

  return [
    `**Approval needed** for \`${delivery.toolName}\``,
    `\`\`\`\n${preview}\n\`\`\``,
    expiry,
  ].join("\n");
};

/** Appends the outcome of an Approval to its prompt text. */
export const resolvedContent = (
  content: string,
  outcome: ApprovalOutcome,
  resolvedBy?: string,
  reason?: string
): string => {
  const by = resolvedBy === undefined ? "" : ` by ${resolvedBy}`;
  const why = reason === undefined ? "" : `: ${reason}`;

  return `${content}\n\n**${OUTCOME_TEXT[outcome]}**${by}${why}`;
};

/** Builds the action row with the four Approval buttons. */
export const approvalButtons = (
  discord: Pick<DiscordRuntime, "ButtonStyle" | "ComponentType">,
  key: string,
  disabled: boolean
): DiscordJs.ActionRowData<DiscordJs.InteractionButtonComponentData> => {
  const styles = {
    allow_always: discord.ButtonStyle.Secondary,
    allow_conversation: discord.ButtonStyle.Secondary,
    allow_once: discord.ButtonStyle.Primary,
    deny: discord.ButtonStyle.Danger,
  } as const satisfies Record<ApprovalDecision, DiscordJs.ButtonStyle>;

  return {
    components: BUTTON_ORDER.map((decision) => ({
      customId: customId(key, decision),
      disabled,
      label: BUTTON_LABELS[decision],
      style: styles[decision],
      type: discord.ComponentType.Button,
    })),
    type: discord.ComponentType.ActionRow,
  };
};

const isPromptRecord = (value: unknown): value is PromptRecord =>
  typeof value === "object" &&
  value !== null &&
  "approvalId" in value &&
  typeof value.approvalId === "string" &&
  "key" in value &&
  typeof value.key === "string" &&
  "channelId" in value &&
  typeof value.channelId === "string" &&
  "messageId" in value &&
  typeof value.messageId === "string" &&
  "content" in value &&
  typeof value.content === "string";

const isStoreFile = (
  value: unknown
): value is { readonly prompts: readonly unknown[] } =>
  typeof value === "object" &&
  value !== null &&
  "prompts" in value &&
  Array.isArray(value.prompts);

const isMissingFile = (cause: unknown): boolean =>
  cause instanceof Error && "code" in cause && cause.code === "ENOENT";

const parseStore = (text: string): PromptRecord[] => {
  const parsed: unknown = JSON.parse(text);

  if (!isStoreFile(parsed)) {
    throw new Error("The Approval prompt file has an unknown format");
  }

  return parsed.prompts.filter(isPromptRecord);
};

/**
 * Keeps the platform message of each pending Approval prompt in the binding's `dataDir`, so that an
 * `approval_resolved` delivery after a daemon restart can still disable the buttons.
 */
export class PromptStore {
  readonly #path: string;
  readonly #dataDir: string;
  readonly #records = new Map<string, PromptRecord>();
  #writes: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.#dataDir = dataDir;
    this.#path = path.join(dataDir, STORE_FILE);
  }

  /** Reads the file. A missing file means no pending prompts. Throws for an unreadable or malformed file. */
  async load(): Promise<void> {
    let text: string;

    try {
      text = await readFile(this.#path, "utf-8");
    } catch (error) {
      if (isMissingFile(error)) {
        return;
      }

      throw error;
    }

    this.#records.clear();

    for (const record of parseStore(text)) {
      this.#records.set(record.approvalId, record);
    }
  }

  get(approvalId: string): PromptRecord | undefined {
    return this.#records.get(approvalId);
  }

  /**
   * Resolves a button `custom_id` key to its Approval ID and stored record. An unhashed key is the Approval ID, so it
   * resolves also without a record. A hashed key needs its record, so it returns `undefined` if the record is gone.
   */
  lookup(
    key: string
  ):
    | { readonly approvalId: string; readonly record: PromptRecord | undefined }
    | undefined {
    for (const record of this.#records.values()) {
      if (record.key === key) {
        return { approvalId: record.approvalId, record };
      }
    }

    return key.startsWith(HASHED_KEY_MARKER)
      ? undefined
      : { approvalId: key, record: undefined };
  }

  /** Stores a record and resolves once the file holds it. */
  async put(record: PromptRecord): Promise<void> {
    this.#records.set(record.approvalId, record);
    await this.#persist();
  }

  /** Removes a record and resolves once the file no longer holds it. */
  async delete(approvalId: string): Promise<void> {
    if (this.#records.delete(approvalId)) {
      await this.#persist();
    }
  }

  async #persist(): Promise<void> {
    const snapshot = JSON.stringify({
      prompts: [...this.#records.values()],
      version: STORE_VERSION,
    });

    const previous = this.#writes;

    const write = async (): Promise<void> => {
      try {
        await previous;
      } catch {
        // The earlier write already rejected to its own caller. This write replaces the whole file anyway.
      }

      await mkdir(this.#dataDir, { recursive: true });
      const temporary = `${this.#path}.tmp`;
      await writeFile(temporary, snapshot);
      await rename(temporary, this.#path);
    };

    // Writes run one at a time, so a slow earlier write cannot replace a newer snapshot.
    const next = write();
    this.#writes = next;
    await next;
  }
}
