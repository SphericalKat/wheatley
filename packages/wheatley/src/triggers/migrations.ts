import type { Migration } from "../db/migrations.js";

/** The migration namespace and table prefix of the Trigger runtime. */
export const TRIGGERS_NAMESPACE = "triggers";

/** The migration namespace and table prefix of the Delivery Outbox. */
export const OUTBOX_NAMESPACE = "outbox";

/**
 * Tables of the Trigger runtime in `agent.sqlite` (ADR 0010):
 * - `triggers_definitions`: every Trigger with its schedule state. `seq` keeps the creation order.
 * - `triggers_webhook_events`: accepted webhook events that wait for their firing, in arrival order.
 * - `triggers_runs`: Runs that a Trigger started, with the `suppress_delivery` flag.
 */
export const triggersMigrations: readonly Migration[] = [
  {
    name: "create triggers, webhook events, and trigger runs",
    up: (db) => {
      db.exec(`
        CREATE TABLE triggers_definitions (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          prompt TEXT NOT NULL,
          schedule_json TEXT NOT NULL,
          target_binding_id TEXT NOT NULL,
          target_chat_id TEXT NOT NULL,
          conversation_mode TEXT NOT NULL CHECK (conversation_mode IN ('per_firing', 'shared')),
          paused INTEGER NOT NULL CHECK (paused IN (0, 1)),
          created_by TEXT NOT NULL CHECK (created_by IN ('agent', 'operator')),
          created_at INTEGER NOT NULL,
          last_fired_at INTEGER,
          next_fire_at INTEGER
        ) STRICT;

        CREATE INDEX triggers_definitions_due ON triggers_definitions (next_fire_at)
          WHERE next_fire_at IS NOT NULL AND paused = 0;

        CREATE TABLE triggers_webhook_events (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          trigger_id TEXT NOT NULL REFERENCES triggers_definitions (id) ON DELETE CASCADE,
          received_at INTEGER NOT NULL,
          headers_json TEXT NOT NULL,
          body BLOB NOT NULL
        ) STRICT;

        CREATE INDEX triggers_webhook_events_trigger ON triggers_webhook_events (trigger_id);

        CREATE TABLE triggers_runs (
          run_id TEXT PRIMARY KEY,
          trigger_id TEXT NOT NULL,
          firing_id TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          suppressed INTEGER NOT NULL DEFAULT 0 CHECK (suppressed IN (0, 1))
        ) STRICT;

        CREATE INDEX triggers_runs_started ON triggers_runs (started_at);
      `);
    },
    version: 1,
  },
];

/**
 * Tables of the Delivery Outbox in `agent.sqlite` (ADR 0007, ADR 0010). `seq` keeps the FIFO order per
 * `(binding_id, chat_id)`.
 */
export const outboxMigrations: readonly Migration[] = [
  {
    name: "create outbox entries",
    up: (db) => {
      db.exec(`
        CREATE TABLE outbox_entries (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          delivery_id TEXT NOT NULL UNIQUE,
          binding_id TEXT NOT NULL,
          chat_id TEXT NOT NULL,
          delivery_json TEXT NOT NULL,
          source_conversation_id TEXT,
          status TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'failed', 'dismissed')),
          attempts INTEGER NOT NULL,
          budget_started_at INTEGER NOT NULL,
          next_attempt_at INTEGER,
          last_error TEXT,
          permanent INTEGER NOT NULL CHECK (permanent IN (0, 1)),
          created_at INTEGER NOT NULL,
          finished_at INTEGER
        ) STRICT;

        CREATE INDEX outbox_entries_chat ON outbox_entries (status, binding_id, chat_id, seq);
      `);
    },
    version: 1,
  },
];
