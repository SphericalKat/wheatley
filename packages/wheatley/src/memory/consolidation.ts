import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type {
  ConsolidationLogEntry,
  MemoryConfig,
} from "@wheatley-ai/protocol";
import type { Logger } from "@wheatley-ai/sdk";
import { Cron } from "croner";

import { SeamError } from "../contracts/errors.js";
import type {
  MaintenanceRunner,
  MaintenanceRunRequest,
  MaintenanceRunResult,
} from "../contracts/maintenance-runner.js";
import type { MemoryStore } from "../contracts/memory-store.js";
import type { Clock } from "../contracts/module.js";
import { errorMessage, fileSizeLine } from "./format.js";
import { rowOf } from "./rows.js";
import type { SqlRow } from "./rows.js";

/** The `RunOrigin.job` of a consolidation Run. */
export const CONSOLIDATION_JOB = "memory.consolidate";

/** The default consolidation schedule: every day at 03:00 in the consolidation timezone. */
export const DEFAULT_CONSOLIDATION_SCHEDULE = "0 3 * * *";

/** The maximum length of the stored summary of a consolidation Run. */
const SUMMARY_MAX_LENGTH = 2000;

/** The longest delay that `setTimeout` supports. A longer wait uses several timers. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** The consolidation settings of an Agent: `memory.consolidation` in `config.yaml`. */
export type ConsolidationConfig = NonNullable<MemoryConfig["consolidation"]>;

/** Options of `createMemoryConsolidation`. */
export interface MemoryConsolidationOptions {
  readonly db: DatabaseSync;
  readonly store: MemoryStore;
  readonly runner: MaintenanceRunner;
  readonly clock: Clock;
  readonly log: Logger;
  readonly config?: ConsolidationConfig;
}

/**
 * The Memory consolidation job of one Agent. A consolidation is a maintenance Run that reviews the Memory files,
 * merges duplicates, removes stale facts, and keeps `MEMORY.md` under its cap with the Memory Tools.
 */
export interface MemoryConsolidation {
  /**
   * Starts a consolidation Run through the `MaintenanceRunner` and adds a `running` entry to the consolidation log.
   * Resolves with the Run ID once the Run is stored. The entry becomes `completed` or `failed` when the Run ends.
   *
   * Errors: throws `SeamError("conflict")` while another consolidation of this Agent runs. If the runner fails to
   * start the Run, the entry becomes `failed` and the runner's error propagates.
   */
  readonly run: () => Promise<{ readonly runId: string }>;
  /**
   * Returns the newest `limit` log entries, newest first.
   *
   * Errors: SQLite errors propagate. A row that does not match the `memory_consolidations` schema throws an `Error`.
   */
  readonly log: (limit: number) => readonly ConsolidationLogEntry[];
  /**
   * Resumes the log entries of Runs that started before a restart, and starts the schedule if consolidation is
   * enabled. If the schedule passed a slot since the last consolidation started, it starts one consolidation at once.
   * A consolidation on demand counts as the last one. If the log is empty, it does not catch up.
   *
   * Errors: SQLite errors from reading or updating the log propagate, and the schedule stays off. Failures of the
   * catch-up consolidation and of scheduled consolidations go to the Agent logger, not to the caller.
   */
  readonly start: () => Promise<void>;
  /**
   * Stops the schedule. Entries of Runs that still run stay `running`, and the next `start` resumes them. Resolves
   * without waiting for Runs to end. Never throws.
   */
  readonly stop: () => Promise<void>;
}

/**
 * Validates the schedule and timezone, and returns the cron job that computes run times. The job has no callback, so
 * it schedules nothing by itself. Throws an `Error` with the config path for an invalid expression or timezone.
 */
const parseSchedule = (config: ConsolidationConfig | undefined): Cron => {
  const schedule = config?.schedule ?? DEFAULT_CONSOLIDATION_SCHEDULE;

  try {
    const cron = new Cron(
      schedule,
      config?.timezone === undefined
        ? { mode: "5-part" }
        : { mode: "5-part", timezone: config.timezone }
    );

    cron.nextRun();

    return cron;
  } catch (error) {
    throw new Error(
      `Invalid memory.consolidation schedule "${schedule}"${config?.timezone === undefined ? "" : ` in timezone ${config.timezone}`}`,
      { cause: error }
    );
  }
};

const LOG_ROW = {
  ended_at: "number?",
  error: "text?",
  id: "text",
  run_id: "text?",
  started_at: "number",
  status: "text",
  summary: "text?",
} as const;

const RUNNING_ROW = { id: "text", run_id: "text?" } as const;
const LAST_ROW = { last: "number?" } as const;

const toLogEntry = (value: SqlRow): ConsolidationLogEntry => {
  const row = rowOf(value, LOG_ROW);

  const entry: ConsolidationLogEntry = {
    endedAt:
      row.ended_at === null ? null : new Date(row.ended_at).toISOString(),
    id: row.id,
    startedAt: new Date(row.started_at).toISOString(),
    status:
      row.status === "completed" || row.status === "failed"
        ? row.status
        : "running",
  };

  if (row.run_id !== null) {
    entry.runId = row.run_id;
  }

  if (row.summary !== null) {
    entry.summary = row.summary;
  }

  if (row.error !== null) {
    entry.error = row.error;
  }

  return entry;
};

/**
 * Creates the consolidation job. If consolidation is enabled, it validates the schedule at once and throws an `Error`
 * if it is invalid. A disabled job ignores the schedule and the timezone.
 */
export const createMemoryConsolidation = (
  options: MemoryConsolidationOptions
): MemoryConsolidation => {
  const { clock, config, db, log, runner, store } = options;
  const enabled = config?.enabled ?? true;
  const cron = enabled ? parseSchedule(config) : undefined;
  let active = false;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const buildPrompt = async (): Promise<string> => {
    const { budget, files } = await store.list();

    const inventory =
      files.length === 0
        ? "Memory has no files yet."
        : files.map(fileSizeLine).join("\n");

    return [
      "Consolidate your Memory. This is a scheduled maintenance Run, and nobody reads your reply live.",
      "",
      "Memory files now:",
      inventory,
      `MEMORY.md uses ${budget.usedChars} of ${budget.maxChars} characters.`,
      "",
      "1. Read each Memory file with memory_read.",
      "2. Merge duplicate facts, and remove facts that are stale or that newer facts contradict. Use memory_search with scope conversations to check recent Conversations when a fact is unclear.",
      "3. Keep MEMORY.md short: the key facts and preferences, and the names of the topic files. Move details into topic files.",
      "4. Delete topic files that are empty or obsolete with memory_delete.",
      "5. Do not invent facts. Change only what the files and Conversations support.",
      "",
      "End with a short summary of your changes.",
    ].join("\n");
  };

  const finish = (id: string, result: MaintenanceRunResult): void => {
    const summary = result.text.trim().slice(0, SUMMARY_MAX_LENGTH);
    const status = result.status === "completed" ? "completed" : "failed";

    const error =
      result.error ??
      (result.status === "stopped"
        ? "The consolidation Run was stopped."
        : undefined);

    db.prepare(
      "UPDATE memory_consolidations SET status = ?, ended_at = ?, summary = ?, error = ? WHERE id = ?"
    ).run(
      status,
      clock.now(),
      summary === "" ? null : summary,
      status === "failed" ? (error ?? null) : null,
      id
    );
  };

  /** Waits for a Run and records its end. Never rejects. */
  const track = async (id: string, runId: string): Promise<void> => {
    let result: MaintenanceRunResult;

    try {
      result = await runner.wait(runId);
    } catch (error) {
      result = {
        error: errorMessage(error),
        status: "failed",
        text: "",
      };
    }

    // After `stop`, the database can be closed. The next `start` resumes the entry.
    if (stopped) {
      return;
    }

    try {
      finish(id, result);
    } catch (error) {
      log.error("Failed to record the end of a Memory consolidation", {
        error: errorMessage(error),
        runId,
      });
    } finally {
      active = false;
    }
  };

  const run = async (): Promise<{ readonly runId: string }> => {
    if (active) {
      throw new SeamError(
        "conflict",
        "A Memory consolidation is already running for this Agent."
      );
    }

    active = true;
    const id = randomUUID();

    try {
      db.prepare(
        "INSERT INTO memory_consolidations (id, status, started_at) VALUES (?, 'running', ?)"
      ).run(id, clock.now());
    } catch (error) {
      active = false;

      throw error;
    }

    let runId: string;

    try {
      const prompt = await buildPrompt();

      const request: MaintenanceRunRequest =
        config?.model === undefined
          ? { job: CONSOLIDATION_JOB, prompt }
          : { job: CONSOLIDATION_JOB, model: config.model, prompt };

      ({ runId } = await runner.start(request));
      db.prepare(
        "UPDATE memory_consolidations SET run_id = ? WHERE id = ?"
      ).run(runId, id);
    } catch (error) {
      finish(id, {
        error: errorMessage(error),
        status: "failed",
        text: "",
      });
      active = false;

      throw error;
    }

    void track(id, runId);

    return { runId };
  };

  const logEntries = (limit: number): readonly ConsolidationLogEntry[] =>
    db
      .prepare(
        `SELECT id, run_id, status, started_at, ended_at, summary, error FROM memory_consolidations
        ORDER BY started_at DESC, rowid DESC LIMIT ?`
      )
      .all(limit)
      .map(toLogEntry);

  const runScheduled = async (): Promise<void> => {
    try {
      const { runId } = await run();

      log.info("Started a scheduled Memory consolidation", { runId });
    } catch (error) {
      if (error instanceof SeamError && error.code === "conflict") {
        log.info(
          "Skipped a scheduled Memory consolidation because one is already running"
        );

        return;
      }

      log.error("Failed to start a scheduled Memory consolidation", {
        error: errorMessage(error),
      });
    }
  };

  const scheduleNext = (schedule: Cron): void => {
    if (stopped) {
      return;
    }

    const next = schedule.nextRun(new Date(clock.now()));

    if (next === null) {
      return;
    }

    const target = next.getTime();

    const wake = (): void => {
      if (stopped) {
        return;
      }

      const remaining = target - clock.now();

      if (remaining > 0) {
        timer = setTimeout(
          wake,
          Math.min(remaining, MAX_TIMER_DELAY_MS)
        ).unref();

        return;
      }

      void runScheduled().finally(() => {
        scheduleNext(schedule);
      });
    };

    timer = setTimeout(
      wake,
      Math.min(Math.max(target - clock.now(), 0), MAX_TIMER_DELAY_MS)
    ).unref();
  };

  const resume = (): void => {
    const rows = db
      .prepare(
        "SELECT id, run_id FROM memory_consolidations WHERE status = 'running'"
      )
      .all()
      .map((value) => rowOf(value, RUNNING_ROW));

    for (const row of rows) {
      if (row.run_id === null) {
        finish(row.id, {
          error: "The daemon stopped before the consolidation Run started.",
          status: "failed",
          text: "",
        });
      } else {
        active = true;
        void track(row.id, row.run_id);
      }
    }
  };

  const missedSlot = (schedule: Cron): boolean => {
    const value = db
      .prepare("SELECT max(started_at) AS last FROM memory_consolidations")
      .get();

    const last = value === undefined ? null : rowOf(value, LAST_ROW).last;
    const [previous] = schedule.previousRuns(1, new Date(clock.now()));

    return last !== null && previous !== undefined && previous.getTime() > last;
  };

  const start = async (): Promise<void> => {
    await Promise.try(() => {
      stopped = false;
      resume();

      if (cron === undefined) {
        return;
      }

      if (missedSlot(cron)) {
        void runScheduled();
      }

      scheduleNext(cron);
    });
  };

  const stop = async (): Promise<void> => {
    await Promise.try(() => {
      stopped = true;
      clearTimeout(timer);
      timer = undefined;
    });
  };

  return { log: logEntries, run, start, stop };
};
