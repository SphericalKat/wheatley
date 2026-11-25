import type { DatabaseSync, SQLOutputValue } from "node:sqlite";

import {
  RunOriginSchema,
  RunTimelineItemSchema,
  decode,
  isJsonValue,
} from "@wheatley-ai/protocol";
import type {
  ChatMessage,
  RunOrigin,
  RunStatus,
  RunSummary,
  RunTimelineItem,
  RunUsage,
} from "@wheatley-ai/protocol";

import type { Migration } from "../../db/migrations.js";

/** The migration namespace of the core Agent tables in `agent.sqlite`. */
export const CORE_NAMESPACE = "core";

/** The core tables: Chats and their current Conversation, Runs, Chat messages, and Run timelines. */
export const coreMigrations: readonly Migration[] = [
  {
    name: "create chats, runs, messages, and timeline",
    up: (db) => {
      db.exec(`
        CREATE TABLE core_chats (
          binding_id TEXT NOT NULL,
          chat_id TEXT NOT NULL,
          conversation_id TEXT NOT NULL,
          PRIMARY KEY (binding_id, chat_id)
        ) STRICT;
        CREATE TABLE core_trigger_conversations (
          trigger_id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL
        ) STRICT;
        CREATE TABLE core_runs (
          seq INTEGER PRIMARY KEY,
          run_id TEXT NOT NULL UNIQUE,
          conversation_id TEXT NOT NULL,
          origin TEXT NOT NULL,
          interactive INTEGER NOT NULL,
          delivery TEXT,
          status TEXT NOT NULL,
          submission_id TEXT,
          started_at TEXT NOT NULL,
          ended_at TEXT,
          error TEXT,
          model TEXT,
          input_tokens INTEGER,
          output_tokens INTEGER,
          cost_usd REAL
        ) STRICT;
        CREATE INDEX core_runs_status ON core_runs (status);
        CREATE TABLE core_messages (
          seq INTEGER PRIMARY KEY,
          message_id TEXT NOT NULL UNIQUE,
          conversation_id TEXT NOT NULL,
          binding_id TEXT,
          chat_id TEXT,
          role TEXT NOT NULL,
          text TEXT NOT NULL,
          run_id TEXT,
          sender TEXT,
          source TEXT,
          at TEXT NOT NULL
        ) STRICT;
        CREATE INDEX core_messages_chat ON core_messages (binding_id, chat_id, seq);
        CREATE TABLE core_timeline (
          seq INTEGER PRIMARY KEY,
          run_id TEXT NOT NULL,
          item_key TEXT NOT NULL UNIQUE,
          item TEXT NOT NULL
        ) STRICT;
        CREATE INDEX core_timeline_run ON core_timeline (run_id, seq);
      `);
    },
    version: 1,
  },
];

type Row = Record<string, SQLOutputValue>;

const isText = (value: SQLOutputValue | undefined): value is string =>
  typeof value === "string";

const isNumber = (value: SQLOutputValue | undefined): value is number =>
  typeof value === "number";

const textOf = (row: Row, column: string): string => {
  const value = row[column];

  if (!isText(value)) {
    throw new Error(`Column ${column} is not text`);
  }

  return value;
};

const optionalText = (row: Row, column: string): string | undefined => {
  const value = row[column];

  return isText(value) ? value : undefined;
};

const optionalNumber = (row: Row, column: string): number | undefined => {
  const value = row[column];

  return isNumber(value) ? value : undefined;
};

const isRunStatus = (value: string): value is RunStatus =>
  value === "running" ||
  value === "waiting_approval" ||
  value === "completed" ||
  value === "failed" ||
  value === "stopped";

const isRole = (value: string): value is ChatMessage["role"] =>
  value === "user" || value === "assistant";

const isSource = (value: string): value is NonNullable<ChatMessage["source"]> =>
  value === "reply" || value === "command" || value === "trigger";

const timelineItemRow = (row: Row): RunTimelineItem => {
  const value: unknown = JSON.parse(textOf(row, "item"));

  const decoded = isJsonValue(value)
    ? decode(RunTimelineItemSchema, value)
    : undefined;

  if (decoded === undefined || !decoded.ok) {
    throw new Error("A stored timeline item is invalid");
  }

  return decoded.value;
};

const messageRow = (row: Row): ChatMessage => {
  const role = textOf(row, "role");
  const source = optionalText(row, "source");

  if (!isRole(role)) {
    throw new Error(`A stored message has the role ${role}`);
  }

  const message: ChatMessage = {
    at: textOf(row, "at"),
    messageId: textOf(row, "message_id"),
    role,
    text: textOf(row, "text"),
  };

  const runId = optionalText(row, "run_id");
  const sender = optionalText(row, "sender");

  if (runId !== undefined) {
    message.runId = runId;
  }

  if (sender !== undefined) {
    message.senderDisplayName = sender;
  }

  if (source !== undefined && isSource(source)) {
    message.source = source;
  }

  return message;
};

/** A Run row with the fields that the Agent needs to continue it after a restart. */
export interface StoredRun {
  readonly summary: RunSummary;
  readonly interactive: boolean;
  readonly submissionId: string | undefined;
  readonly delivery: RunDelivery | null;
}

/** A new Run. */
export interface RunInsert {
  readonly runId: string;
  readonly conversationId: string;
  readonly origin: RunOrigin;
  readonly interactive: boolean;
  readonly startedAt: string;
  readonly model: string | undefined;
  readonly delivery: RunDelivery | null;
}

/** Where the final reply of a Run goes through the outbox, for Runs whose Chat is not the CLI Chat. */
export interface RunDelivery {
  readonly bindingId: string;
  readonly chatId: string;
  readonly source: "reply" | "trigger";
  /** For Trigger Runs: the Conversation that produced the reply (ADR 0010). */
  readonly sourceConversationId?: string;
}

const isRunDelivery = (value: unknown): value is RunDelivery =>
  typeof value === "object" &&
  value !== null &&
  "bindingId" in value &&
  typeof value.bindingId === "string" &&
  "chatId" in value &&
  typeof value.chatId === "string" &&
  "source" in value &&
  (value.source === "reply" || value.source === "trigger");

/** A new Chat message. */
export interface MessageInsert {
  readonly message: ChatMessage;
  readonly conversationId: string;
  readonly chat: { readonly bindingId: string; readonly chatId: string } | null;
}

/** How a Run ended. */
export interface RunEnd {
  readonly status: "completed" | "failed" | "stopped";
  readonly endedAt: string;
  readonly error?: string;
  readonly usage?: RunUsage;
}

/** Reads and writes the core tables of one `agent.sqlite`. Every method runs synchronously in one statement. */
export class AgentStore {
  readonly #db: DatabaseSync;
  readonly #agent: string;

  constructor(db: DatabaseSync, agent: string) {
    this.#db = db;
    this.#agent = agent;
  }

  /** The current Conversation of a Chat, or `undefined` before its first message. */
  readonly chatConversation = (
    bindingId: string,
    chatId: string
  ): string | undefined => {
    const row = this.#db
      .prepare(
        "SELECT conversation_id FROM core_chats WHERE binding_id = ? AND chat_id = ?"
      )
      .get(bindingId, chatId);

    return row === undefined ? undefined : textOf(row, "conversation_id");
  };

  /** Points a Chat at a new current Conversation. */
  readonly setChatConversation = (
    bindingId: string,
    chatId: string,
    conversationId: string
  ): void => {
    this.#db
      .prepare(
        `INSERT INTO core_chats (binding_id, chat_id, conversation_id) VALUES (?, ?, ?)
         ON CONFLICT (binding_id, chat_id) DO UPDATE SET conversation_id = excluded.conversation_id`
      )
      .run(bindingId, chatId, conversationId);
  };

  /** The shared Conversation of a Trigger, or `undefined` before its first `shared` firing. */
  readonly triggerConversation = (triggerId: string): string | undefined => {
    const row = this.#db
      .prepare(
        "SELECT conversation_id FROM core_trigger_conversations WHERE trigger_id = ?"
      )
      .get(triggerId);

    return row === undefined ? undefined : textOf(row, "conversation_id");
  };

  readonly setTriggerConversation = (
    triggerId: string,
    conversationId: string
  ): void => {
    this.#db
      .prepare(
        `INSERT INTO core_trigger_conversations (trigger_id, conversation_id) VALUES (?, ?)
         ON CONFLICT (trigger_id) DO UPDATE SET conversation_id = excluded.conversation_id`
      )
      .run(triggerId, conversationId);
  };

  readonly insertRun = (run: RunInsert): void => {
    this.#db
      .prepare(
        `INSERT INTO core_runs (run_id, conversation_id, origin, interactive, delivery, status, started_at, model)
         VALUES (?, ?, ?, ?, ?, 'running', ?, ?)`
      )
      .run(
        run.runId,
        run.conversationId,
        JSON.stringify(run.origin),
        run.interactive ? 1 : 0,
        run.delivery === null ? null : JSON.stringify(run.delivery),
        run.startedAt,
        run.model ?? null
      );
  };

  readonly setSubmission = (runId: string, submissionId: string): void => {
    this.#db
      .prepare("UPDATE core_runs SET submission_id = ? WHERE run_id = ?")
      .run(submissionId, runId);
  };

  /** Moves an active Run between `running` and `waiting_approval`. Resolves `false` if the Run already ended. */
  readonly setActiveStatus = (
    runId: string,
    status: "running" | "waiting_approval"
  ): boolean =>
    this.#db
      .prepare(
        "UPDATE core_runs SET status = ? WHERE run_id = ? AND status IN ('running', 'waiting_approval') AND status <> ?"
      )
      .run(status, runId, status).changes > 0;

  /** Ends an active Run. Resolves `false` if it already ended. */
  readonly endRun = (runId: string, end: RunEnd): boolean =>
    this.#db
      .prepare(
        `UPDATE core_runs SET status = ?, ended_at = ?, error = ?, input_tokens = ?, output_tokens = ?, cost_usd = ?
         WHERE run_id = ? AND status IN ('running', 'waiting_approval')`
      )
      .run(
        end.status,
        end.endedAt,
        end.error ?? null,
        end.usage?.inputTokens ?? null,
        end.usage?.outputTokens ?? null,
        end.usage?.costUsd ?? null,
        runId
      ).changes > 0;

  readonly getRun = (runId: string): StoredRun | undefined => {
    const row = this.#db
      .prepare("SELECT * FROM core_runs WHERE run_id = ?")
      .get(runId);

    return row === undefined ? undefined : this.#storedRun(row);
  };

  /** Runs that are `running` or `waiting_approval`, oldest first. */
  readonly activeRuns = (): StoredRun[] =>
    this.#db
      .prepare(
        "SELECT * FROM core_runs WHERE status IN ('running', 'waiting_approval') ORDER BY seq"
      )
      .all()
      .map((row) => this.#storedRun(row));

  /** Runs newest first, after the Run `before` if given. Fetches `limit + 1` rows so callers can set `hasMore`. */
  readonly listRuns = (options: {
    readonly before: string | undefined;
    readonly limit: number;
    readonly activeOnly: boolean;
  }): RunSummary[] => {
    const beforeSeq =
      options.before === undefined
        ? undefined
        : optionalNumber(
            this.#db
              .prepare("SELECT seq FROM core_runs WHERE run_id = ?")
              .get(options.before) ?? {},
            "seq"
          );

    const status = options.activeOnly
      ? "AND status IN ('running', 'waiting_approval')"
      : "";

    return this.#db
      .prepare(
        `SELECT * FROM core_runs WHERE seq < ? ${status} ORDER BY seq DESC LIMIT ?`
      )
      .all(beforeSeq ?? Number.MAX_SAFE_INTEGER, options.limit + 1)
      .map((row) => this.#storedRun(row).summary);
  };

  readonly insertMessage = (insert: MessageInsert): void => {
    const { message } = insert;

    this.#db
      .prepare(
        `INSERT INTO core_messages (message_id, conversation_id, binding_id, chat_id, role, text, run_id, sender, source, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        message.messageId,
        insert.conversationId,
        insert.chat?.bindingId ?? null,
        insert.chat?.chatId ?? null,
        message.role,
        message.text,
        message.runId ?? null,
        message.senderDisplayName ?? null,
        message.source ?? null,
        message.at
      );
  };

  /** Messages of a Conversation in a Chat, oldest first, before the message `before`. Fetches `limit + 1`. */
  readonly chatMessages = (
    conversationId: string,
    before: string | undefined,
    limit: number
  ): ChatMessage[] => {
    const beforeSeq =
      before === undefined
        ? undefined
        : optionalNumber(
            this.#db
              .prepare("SELECT seq FROM core_messages WHERE message_id = ?")
              .get(before) ?? {},
            "seq"
          );

    return this.#db
      .prepare(
        "SELECT * FROM core_messages WHERE conversation_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?"
      )
      .all(conversationId, beforeSeq ?? Number.MAX_SAFE_INTEGER, limit + 1)
      .map((row) => messageRow(row))
      .toReversed();
  };

  /** The last assistant message text of a Run, or an empty string. */
  readonly runReply = (runId: string): string => {
    const row = this.#db
      .prepare(
        "SELECT text FROM core_messages WHERE run_id = ? AND role = 'assistant' ORDER BY seq DESC LIMIT 1"
      )
      .get(runId);

    return row === undefined ? "" : textOf(row, "text");
  };

  /** Adds a timeline item, or replaces the item with the same key, for example a Tool call that finished. */
  readonly putTimelineItem = (
    runId: string,
    key: string,
    item: RunTimelineItem
  ): void => {
    this.#db
      .prepare(
        `INSERT INTO core_timeline (run_id, item_key, item) VALUES (?, ?, ?)
         ON CONFLICT (item_key) DO UPDATE SET item = excluded.item`
      )
      .run(runId, key, JSON.stringify(item));
  };

  readonly timelineItem = (key: string): RunTimelineItem | undefined => {
    const row = this.#db
      .prepare("SELECT item FROM core_timeline WHERE item_key = ?")
      .get(key);

    return row === undefined ? undefined : timelineItemRow(row);
  };

  readonly timeline = (runId: string): RunTimelineItem[] =>
    this.#db
      .prepare("SELECT item FROM core_timeline WHERE run_id = ? ORDER BY seq")
      .all(runId)
      .map((row) => timelineItemRow(row));

  readonly #storedRun = (row: Row): StoredRun => {
    const status = textOf(row, "status");
    const originValue: unknown = JSON.parse(textOf(row, "origin"));

    const origin = isJsonValue(originValue)
      ? decode(RunOriginSchema, originValue)
      : undefined;

    if (!isRunStatus(status) || origin === undefined || !origin.ok) {
      throw new Error("A stored Run is invalid");
    }

    const summary: RunSummary = {
      agent: this.#agent,
      conversationId: textOf(row, "conversation_id"),
      endedAt: optionalText(row, "ended_at") ?? null,
      origin: origin.value,
      runId: textOf(row, "run_id"),
      startedAt: textOf(row, "started_at"),
      status,
    };

    const error = optionalText(row, "error");
    const model = optionalText(row, "model");
    const inputTokens = optionalNumber(row, "input_tokens");
    const outputTokens = optionalNumber(row, "output_tokens");
    const costUsd = optionalNumber(row, "cost_usd");

    if (error !== undefined) {
      summary.error = error;
    }

    if (model !== undefined) {
      summary.model = model;
    }

    if (inputTokens !== undefined && outputTokens !== undefined) {
      summary.usage =
        costUsd === undefined
          ? { inputTokens, outputTokens }
          : { costUsd, inputTokens, outputTokens };
    }

    const deliveryText = optionalText(row, "delivery");

    const delivery: unknown =
      deliveryText === undefined ? null : JSON.parse(deliveryText);

    return {
      delivery: isRunDelivery(delivery) ? delivery : null,
      interactive: optionalNumber(row, "interactive") === 1,
      submissionId: optionalText(row, "submission_id"),
      summary,
    };
  };
}
