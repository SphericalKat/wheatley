import type { ModelChoice } from "@wheatley/protocol";

/** One internal maintenance Run, for example Memory consolidation. */
export interface MaintenanceRunRequest {
  /** The job name that `RunOrigin.job` shows, for example `memory.consolidate`. */
  readonly job: string;
  /** The instruction for the Run. */
  readonly prompt: string;
  /** Replaces the Agent's model for this Run only, for example `memory.consolidation.model`. */
  readonly model?: ModelChoice;
}

/** How a maintenance Run ended. */
export interface MaintenanceRunResult {
  readonly status: "completed" | "failed" | "stopped";
  /** The final assistant text, or an empty string if the Run produced none. */
  readonly text: string;
  readonly error?: string;
}

/**
 * Starts internal maintenance Runs of one Agent. The core Agent implements it, because only the Agent's pi adapter
 * starts Runs. The Memory module uses it for consolidation (`memory.consolidate` and the schedule).
 *
 * A maintenance Run has `RunOrigin` `{ kind: "maintenance", job }`. It runs in a new Conversation, takes a Concurrency
 * Gate slot for its model's credential, is non-interactive (the gate denies `ask` Tools, ADR 0011), and delivers
 * nothing to a Chat.
 */
export interface MaintenanceRunner {
  /** Starts a Run and resolves with its ID once the Run is stored. */
  readonly start: (
    request: MaintenanceRunRequest
  ) => Promise<{ readonly runId: string }>;
  /**
   * Resolves when the Run ends, also for a Run that started before a daemon restart. Throws `SeamError("not_found")`
   * for an unknown Run or a Run that is not a maintenance Run.
   */
  readonly wait: (runId: string) => Promise<MaintenanceRunResult>;
}
