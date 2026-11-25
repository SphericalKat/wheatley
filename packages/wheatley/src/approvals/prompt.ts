import { APPROVAL_REASON_MAX_LENGTH } from "@wheatley/protocol";
import type { ApprovalDecision, PendingApproval } from "@wheatley/protocol";
import type { ApprovalResolution } from "@wheatley/sdk";

import { systemClock } from "../contracts/module.js";
import type { Clock } from "../contracts/module.js";

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;

const CHOICES =
  "[o] allow once  [c] allow for this conversation  [a] always allow  [d] deny";

const RETRY_QUESTION = "Answer o, c, a, or d: ";

const REASON_QUESTION =
  "Reason for the denial (optional, press Enter to skip): ";

const ANSWERS: ReadonlyMap<string, ApprovalDecision> = new Map([
  ["a", "allow_always"],
  ["always", "allow_always"],
  ["c", "allow_conversation"],
  ["conversation", "allow_conversation"],
  ["d", "deny"],
  ["deny", "deny"],
  ["n", "deny"],
  ["no", "deny"],
  ["o", "allow_once"],
  ["once", "allow_once"],
]);

/** Formats a remaining time, for example `1h 5m`, `14m 59s`, or `30s`. */
const formatRemaining = (ms: number): string => {
  const hours = Math.floor(ms / HOUR_MS);
  const minutes = Math.floor((ms % HOUR_MS) / MINUTE_MS);
  const seconds = Math.floor((ms % MINUTE_MS) / SECOND_MS);

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }

  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
};

const deadlineLine = (expiresAt: string | null, now: number): string => {
  if (expiresAt === null) {
    return "No timeout";
  }

  const remaining = Date.parse(expiresAt) - now;

  return remaining > 0
    ? `Times out in ${formatRemaining(remaining)} (${expiresAt})`
    : `Timed out at ${expiresAt}`;
};

/**
 * Renders the CLI card of a pending Approval: the Tool, its redacted input preview, the deadline, and the four
 * choices. `now` is epoch milliseconds.
 */
export const renderApprovalPrompt = (
  approval: PendingApproval,
  now: number
): string =>
  [
    `Approval needed: ${approval.toolName}`,
    `Input: ${approval.inputPreview}`,
    deadlineLine(approval.expiresAt, now),
    CHOICES,
  ].join("\n");

/**
 * Parses an answer to the CLI card, case-insensitively: `o`/`once`, `c`/`conversation`, `a`/`always`, and
 * `d`/`deny`/`n`/`no`. Returns `undefined` for any other answer.
 */
export const parseApprovalAnswer = (
  answer: string
): ApprovalDecision | undefined => ANSWERS.get(answer.trim().toLowerCase());

/** The terminal and the cancellation of one CLI Approval prompt. */
export interface ApprovalPromptOptions {
  /**
   * Shows `query` and resolves with the next input line, for example `Interface.question` of `node:readline/promises`.
   * It must reject when `options.signal` aborts.
   */
  readonly question: (
    query: string,
    options: { readonly signal: AbortSignal }
  ) => Promise<string>;
  /** Ends the prompt without a decision, for example when an `approval.resolved` event arrives for the Approval. */
  readonly signal?: AbortSignal;
  /** The display name to send as `resolvedBy`. */
  readonly resolvedBy?: string;
  readonly clock?: Clock;
}

/**
 * Shows the CLI card of `approval` and asks until the answer is valid. After `deny`, it asks for an optional reason.
 * Resolves with the resolution to send through `approvals.decide`, or `undefined` if `options.signal` aborts first.
 *
 * Errors: it rejects with the error of `question`, except the rejection that an aborted `signal` causes.
 */
export const promptForApproval = async (
  approval: PendingApproval,
  options: ApprovalPromptOptions
): Promise<ApprovalResolution | undefined> => {
  const signal = options.signal ?? new AbortController().signal;
  const clock = options.clock ?? systemClock;

  const ask = async (query: string): Promise<string | undefined> => {
    try {
      return await options.question(query, { signal });
    } catch (error) {
      if (signal.aborted) {
        return undefined;
      }

      throw error;
    }
  };

  let query = `${renderApprovalPrompt(approval, clock.now())}\n> `;
  let decision: ApprovalDecision | undefined;

  while (decision === undefined) {
    // oxlint-disable-next-line no-await-in-loop -- Each question waits for the answer to the previous one.
    const answer = await ask(query);

    if (answer === undefined) {
      return undefined;
    }

    decision = parseApprovalAnswer(answer);
    query = RETRY_QUESTION;
  }

  const resolvedBy =
    options.resolvedBy === undefined ? {} : { resolvedBy: options.resolvedBy };

  if (decision !== "deny") {
    return { decision, ...resolvedBy };
  }

  const answer = await ask(REASON_QUESTION);

  if (answer === undefined) {
    return undefined;
  }

  const reason = answer.trim().slice(0, APPROVAL_REASON_MAX_LENGTH);

  return reason === ""
    ? { decision, ...resolvedBy }
    : { decision, reason, ...resolvedBy };
};
