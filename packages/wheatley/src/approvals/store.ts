import type { DatabaseSync, SQLOutputValue } from "node:sqlite";

import type {
  ApprovalOutcome,
  ChatKey,
  PendingApproval,
} from "@wheatley/protocol";

import type { ParkedCall } from "../contracts/approval-gate.js";
import type { Migration } from "../db/migrations.js";

/** The `agent.sqlite` schema of the `approvals` namespace. */
export const approvalsMigrations: readonly Migration[] = [
  {
    name: "create approvals, waiters, and grants",
    up: (db) => {
      db.exec(`
        CREATE TABLE approvals_requests (
          approval_id TEXT PRIMARY KEY,
          call_key TEXT NOT NULL UNIQUE,
          run_id TEXT NOT NULL,
          conversation_id TEXT NOT NULL,
          binding_id TEXT,
          chat_id TEXT,
          tool_name TEXT NOT NULL,
          input_preview TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER,
          outcome TEXT CHECK (outcome IN (
            'allow_once', 'allow_conversation', 'allow_always', 'deny', 'timeout', 'cancelled'
          )),
          reason TEXT,
          resolved_by TEXT,
          resolved_at INTEGER,
          CHECK ((binding_id IS NULL) = (chat_id IS NULL)),
          CHECK ((outcome IS NULL) = (resolved_at IS NULL))
        ) STRICT;
        CREATE INDEX approvals_requests_pending
          ON approvals_requests (run_id, created_at) WHERE outcome IS NULL;
        CREATE TABLE approvals_waiters (
          approval_id TEXT NOT NULL REFERENCES approvals_requests (approval_id) ON DELETE CASCADE,
          call_key TEXT NOT NULL,
          signal_key TEXT NOT NULL,
          PRIMARY KEY (approval_id, call_key)
        ) STRICT;
        CREATE INDEX approvals_waiters_call ON approvals_waiters (call_key);
        CREATE TABLE approvals_grants (
          conversation_id TEXT NOT NULL,
          tool_name TEXT NOT NULL,
          granted_at INTEGER NOT NULL,
          PRIMARY KEY (conversation_id, tool_name)
        ) STRICT;
      `);
    },
    version: 1,
  },
];

const OUTCOMES: readonly ApprovalOutcome[] = [
  "allow_once",
  "allow_conversation",
  "allow_always",
  "deny",
  "timeout",
  "cancelled",
];

const isOutcome = (
  value: SQLOutputValue | undefined
): value is ApprovalOutcome => OUTCOMES.some((outcome) => outcome === value);

/** One stored Approval. Times are epoch milliseconds. */
export interface StoredApproval {
  readonly approvalId: string;
  readonly callKey: string;
  readonly runId: string;
  readonly conversationId: string;
  readonly chat: ChatKey | null;
  readonly toolName: string;
  readonly inputPreview: string;
  readonly createdAt: number;
  readonly expiresAt: number | null;
  readonly outcome: ApprovalOutcome | null;
  readonly reason: string | null;
  readonly resolvedBy: string | null;
}

/** The fields of a new Approval. */
export type NewApproval = Omit<
  StoredApproval,
  "outcome" | "reason" | "resolvedBy"
>;

/** A resolution to store. */
export interface StoredResolution {
  readonly outcome: ApprovalOutcome;
  readonly reason: string | undefined;
  readonly resolvedBy: string | undefined;
  readonly resolvedAt: number;
}

type Row = Record<string, SQLOutputValue>;

/** An `approvals_requests` row as `node:sqlite` returns it. */
interface ApprovalRow {
  readonly approval_id: string;
  readonly call_key: string;
  readonly run_id: string;
  readonly conversation_id: string;
  readonly binding_id: string | null;
  readonly chat_id: string | null;
  readonly tool_name: string;
  readonly input_preview: string;
  readonly created_at: number;
  readonly expires_at: number | null;
  readonly outcome: ApprovalOutcome | null;
  readonly reason: string | null;
  readonly resolved_by: string | null;
}

/** An `approvals_waiters` row. */
interface WaiterRow {
  readonly call_key: string;
  readonly signal_key: string;
}

const isText = (value: SQLOutputValue | undefined): value is string =>
  typeof value === "string";

const isTextOrNull = (
  value: SQLOutputValue | undefined
): value is string | null => value === null || isText(value);

const isIntegerOrNull = (
  value: SQLOutputValue | undefined
): value is number | null => value === null || Number.isSafeInteger(value);

const isApprovalRow = (row: Row): row is Row & ApprovalRow =>
  isText(row.approval_id) &&
  isText(row.call_key) &&
  isText(row.run_id) &&
  isText(row.conversation_id) &&
  isTextOrNull(row.binding_id) &&
  isTextOrNull(row.chat_id) &&
  isText(row.tool_name) &&
  isText(row.input_preview) &&
  Number.isSafeInteger(row.created_at) &&
  isIntegerOrNull(row.expires_at) &&
  (row.outcome === null || isOutcome(row.outcome)) &&
  isTextOrNull(row.reason) &&
  isTextOrNull(row.resolved_by);

const isWaiterRow = (row: Row): row is Row & WaiterRow =>
  isText(row.call_key) && isText(row.signal_key);

const toApproval = (row: Row): StoredApproval => {
  if (!isApprovalRow(row)) {
    throw new TypeError(
      `Invalid approvals_requests row: ${String(row.approval_id)}`
    );
  }

  return {
    approvalId: row.approval_id,
    callKey: row.call_key,
    chat:
      row.binding_id === null || row.chat_id === null
        ? null
        : { bindingId: row.binding_id, chatId: row.chat_id },
    conversationId: row.conversation_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    inputPreview: row.input_preview,
    outcome: row.outcome,
    reason: row.reason,
    resolvedBy: row.resolved_by,
    runId: row.run_id,
    toolName: row.tool_name,
  };
};

const toParkedCall = (row: Row): ParkedCall => {
  if (!isWaiterRow(row)) {
    throw new TypeError("Invalid approvals_waiters row");
  }

  return { callKey: row.call_key, signalKey: row.signal_key };
};

const toOptionalApproval = (row: Row | undefined): StoredApproval | undefined =>
  row === undefined ? undefined : toApproval(row);

const toIso = (epochMs: number): string => new Date(epochMs).toISOString();

/** Converts a stored Approval to the protocol shape. */
export const toPendingApproval = (
  agent: string,
  approval: StoredApproval
): PendingApproval => ({
  agent,
  approvalId: approval.approvalId,
  chat: approval.chat,
  conversationId: approval.conversationId,
  createdAt: toIso(approval.createdAt),
  expiresAt: approval.expiresAt === null ? null : toIso(approval.expiresAt),
  inputPreview: approval.inputPreview,
  runId: approval.runId,
  toolName: approval.toolName,
});

const COLUMNS = `approval_id, call_key, run_id, conversation_id, binding_id, chat_id, tool_name, input_preview,
  created_at, expires_at, outcome, reason, resolved_by`;

/**
 * Synchronous access to the `approvals_*` tables. Every method runs one statement, so a caller that does not await
 * between two calls sees no write of another caller in between.
 *
 * Errors: a read throws `TypeError` if a row does not match the schema. A write throws the `node:sqlite` error.
 */
export interface ApprovalStore {
  /** The Approval with this ID, or `undefined`. */
  readonly byId: (approvalId: string) => StoredApproval | undefined;
  /** The Approval that this call opened, or `undefined`. A call opens at most one Approval. */
  readonly byCallKey: (callKey: string) => StoredApproval | undefined;
  /** The oldest pending Approval of the Run, or `undefined`. */
  readonly oldestPendingInRun: (runId: string) => StoredApproval | undefined;
  /** Pending Approvals, oldest first, optionally of one Run. */
  readonly pending: (runId?: string) => StoredApproval[];
  /** Stores a pending Approval. Throws a UNIQUE constraint error if the ID or the `callKey` already has an Approval. */
  readonly insert: (approval: NewApproval) => void;
  /** Stores the resolution if the Approval is still pending. Returns `true` if this call resolved it. */
  readonly resolve: (
    approvalId: string,
    resolution: StoredResolution
  ) => boolean;
  /** Registers a parked call. A second registration of the same call keeps the first one. */
  readonly addWaiter: (approvalId: string, call: ParkedCall) => void;
  /** The calls that waited on the Approval, in the order they parked. Resolution does not remove them. */
  readonly waiters: (approvalId: string) => ParkedCall[];
  /** `true` if the call waited on an Approval that ended as `cancelled`. */
  readonly waitedOnCancelled: (callKey: string) => boolean;
  /** `true` if the Conversation has an `allow_conversation` grant for the Tool. */
  readonly hasGrant: (conversationId: string, toolName: string) => boolean;
  /** Stores an `allow_conversation` grant. A second grant for the same pair keeps the first one. */
  readonly addGrant: (
    conversationId: string,
    toolName: string,
    grantedAt: number
  ) => void;
  /** Removes every grant of the Conversation. */
  readonly clearGrants: (conversationId: string) => void;
}

/** Creates the store on an `agent.sqlite` handle with the `approvals` migrations applied. */
export const createApprovalStore = (db: DatabaseSync): ApprovalStore => {
  const selectById = db.prepare(
    `SELECT ${COLUMNS} FROM approvals_requests WHERE approval_id = ?`
  );

  const selectByCallKey = db.prepare(
    `SELECT ${COLUMNS} FROM approvals_requests WHERE call_key = ?`
  );

  const selectPendingInRun = db.prepare(
    `SELECT ${COLUMNS} FROM approvals_requests WHERE outcome IS NULL AND run_id = ? ORDER BY created_at, rowid`
  );

  const selectPending = db.prepare(
    `SELECT ${COLUMNS} FROM approvals_requests WHERE outcome IS NULL ORDER BY created_at, rowid`
  );

  const insertApproval = db.prepare(
    `INSERT INTO approvals_requests (
      approval_id, call_key, run_id, conversation_id, binding_id, chat_id, tool_name, input_preview, created_at,
      expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const updateResolution = db.prepare(
    `UPDATE approvals_requests SET outcome = ?, reason = ?, resolved_by = ?, resolved_at = ?
     WHERE approval_id = ? AND outcome IS NULL`
  );

  const insertWaiter = db.prepare(
    "INSERT OR IGNORE INTO approvals_waiters (approval_id, call_key, signal_key) VALUES (?, ?, ?)"
  );

  const selectWaiters = db.prepare(
    "SELECT call_key, signal_key FROM approvals_waiters WHERE approval_id = ? ORDER BY rowid"
  );

  const selectCancelledWait = db.prepare(
    `SELECT 1 FROM approvals_waiters JOIN approvals_requests USING (approval_id)
     WHERE approvals_waiters.call_key = ? AND outcome = 'cancelled' LIMIT 1`
  );

  const selectGrant = db.prepare(
    "SELECT 1 FROM approvals_grants WHERE conversation_id = ? AND tool_name = ?"
  );

  const insertGrant = db.prepare(
    "INSERT OR IGNORE INTO approvals_grants (conversation_id, tool_name, granted_at) VALUES (?, ?, ?)"
  );

  const deleteGrants = db.prepare(
    "DELETE FROM approvals_grants WHERE conversation_id = ?"
  );

  return {
    addGrant: (conversationId, toolName, grantedAt) => {
      insertGrant.run(conversationId, toolName, grantedAt);
    },
    addWaiter: (approvalId, call) => {
      insertWaiter.run(approvalId, call.callKey, call.signalKey);
    },
    byCallKey: (callKey) => toOptionalApproval(selectByCallKey.get(callKey)),
    byId: (approvalId) => toOptionalApproval(selectById.get(approvalId)),
    clearGrants: (conversationId) => {
      deleteGrants.run(conversationId);
    },
    hasGrant: (conversationId, toolName) =>
      selectGrant.get(conversationId, toolName) !== undefined,
    insert: (approval) => {
      insertApproval.run(
        approval.approvalId,
        approval.callKey,
        approval.runId,
        approval.conversationId,
        approval.chat?.bindingId ?? null,
        approval.chat?.chatId ?? null,
        approval.toolName,
        approval.inputPreview,
        approval.createdAt,
        approval.expiresAt
      );
    },
    oldestPendingInRun: (runId) =>
      toOptionalApproval(selectPendingInRun.get(runId)),
    pending: (runId) =>
      (runId === undefined
        ? selectPending.all()
        : selectPendingInRun.all(runId)
      ).map(toApproval),
    resolve: (approvalId, resolution) =>
      Number(
        updateResolution.run(
          resolution.outcome,
          resolution.reason ?? null,
          resolution.resolvedBy ?? null,
          resolution.resolvedAt,
          approvalId
        ).changes
      ) === 1,
    waitedOnCancelled: (callKey) =>
      selectCancelledWait.get(callKey) !== undefined,
    waiters: (approvalId) => selectWaiters.all(approvalId).map(toParkedCall),
  };
};
