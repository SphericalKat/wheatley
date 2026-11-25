import type { AgentState, EventPayload } from "@wheatley-ai/protocol";
import type { Logger } from "@wheatley-ai/sdk";

import type { Clock, EventSink } from "../contracts/module.js";
import { SerialQueue } from "./config/atomic-file.js";
import { errorMessage } from "./error-message.js";

/** The first wait before the Supervisor restarts a degraded Agent. */
export const RESTART_BACKOFF_INITIAL_MS = 1000;

/** The longest wait between restart attempts. */
export const RESTART_BACKOFF_MAX_MS = 60_000;

/** What the Supervisor needs from a running Agent. */
export interface SupervisedAgent {
  /** Releases everything. It must resolve, also after a failure. */
  readonly close: () => Promise<void>;
}

/** Callbacks that a running Agent uses to reach its Supervisor. */
export interface AgentControls {
  /** The Agent failed while it ran, for example after a Harness storage error. */
  readonly onFailed: (error: Error) => void;
  /** The Agent asks for its own restart, for example for `/restart`. */
  readonly onRestartRequested: () => void;
}

/** Arms a timer and returns the function that cancels it. Tests pass fake timers. */
export type SetTimer = (callback: () => void, delayMs: number) => () => void;

/** The `SetTimer` of production: a `setTimeout` that does not keep the process alive. */
export const defaultSetTimer: SetTimer = (callback, delayMs) => {
  const timer = setTimeout(callback, delayMs);

  timer.unref();

  return () => {
    clearTimeout(timer);
  };
};

/** Options of a `Supervisor`. */
export interface SupervisorOptions<A extends SupervisedAgent> {
  /** Opens an Agent. It rejects if the Agent cannot start. */
  readonly open: (name: string, controls: AgentControls) => Promise<A>;
  readonly events: EventSink;
  readonly log: Logger;
  readonly clock: Clock;
  readonly setTimer?: SetTimer;
}

/** The Supervisor's view of one Agent. */
export interface SupervisedState<A extends SupervisedAgent> {
  readonly state: AgentState;
  readonly instance: A | undefined;
  readonly lastError: string | null;
  /** Milliseconds until the next restart attempt, or `null`. */
  readonly restartBackoffMs: number | null;
}

interface Entry<A extends SupervisedAgent> {
  state: AgentState;
  instance: A | undefined;
  lastError: string | null;
  failures: number;
  restartAt: number | null;
  cancelRestart: (() => void) | undefined;
  /** Each start, open, or failure bumps it, so callbacks of an older instance do nothing. */
  generation: number;
  readonly queue: SerialQueue;
}

/** Cancels a pending restart attempt. */
const clearRestart = <A extends SupervisedAgent>(entry: Entry<A>): void => {
  entry.cancelRestart?.();
  entry.cancelRestart = undefined;
  entry.restartAt = null;
};

/**
 * Starts, stops, and restarts the Agents of a Deployment, each on its own (ADR 0001). A failed start or a failure while
 * running moves only that Agent to `degraded`, and the Supervisor retries it with exponential backoff
 * (`RESTART_BACKOFF_INITIAL_MS` doubling up to `RESTART_BACKOFF_MAX_MS`). Other Agents keep running.
 *
 * Ordering: lifecycle calls for one Agent run one at a time, in call order. Every state change emits `agent.status`.
 */
export class Supervisor<A extends SupervisedAgent> {
  readonly #options: SupervisorOptions<A>;
  readonly #setTimer: SetTimer;
  readonly #entries = new Map<string, Entry<A>>();

  constructor(options: SupervisorOptions<A>) {
    this.#options = options;
    this.#setTimer = options.setTimer ?? defaultSetTimer;
  }

  /** The names of every known Agent, sorted. */
  get names(): string[] {
    return [...this.#entries.keys()].toSorted();
  }

  /** The state of an Agent, or `undefined` for an unknown name. */
  readonly get = (name: string): SupervisedState<A> | undefined => {
    const entry = this.#entries.get(name);

    if (entry === undefined) {
      return undefined;
    }

    return {
      instance: entry.instance,
      lastError: entry.lastError,
      restartBackoffMs:
        entry.restartAt === null
          ? null
          : Math.max(0, entry.restartAt - this.#options.clock.now()),
      state: entry.state,
    };
  };

  /**
   * Resolves once no lifecycle call (`start`, `stop`, `restart`, `remove`, a failure, or a retry that fired) for `name`
   * is queued or running. A pending retry timer does not count until it fires. It resolves at once for an unknown name
   * and never rejects.
   */
  readonly settled = async (name: string): Promise<void> => {
    await this.#entries.get(name)?.queue.idle();
  };

  /**
   * Starts an Agent and resolves with its new state: `running`, or `degraded` if `open` rejected. Starting a running
   * Agent does nothing. A degraded Agent starts at once, and its pending retry is cancelled.
   */
  readonly start = async (name: string): Promise<AgentState> => {
    const entry = this.#entry(name);

    return await entry.queue.run(async () => await this.#start(name, entry));
  };

  /** Stops an Agent and resolves `stopped`. It cancels a pending retry. Stopping a stopped Agent does nothing. */
  readonly stop = async (name: string): Promise<AgentState> => {
    const entry = this.#entry(name);

    return await entry.queue.run(async () => await this.#stop(name, entry));
  };

  /** Stops and starts an Agent, and resolves with its new state. */
  readonly restart = async (name: string): Promise<AgentState> => {
    const entry = this.#entry(name);

    return await entry.queue.run(async () => {
      await this.#stop(name, entry);

      return await this.#start(name, entry);
    });
  };

  /** Stops an Agent and forgets it, for an Agent that left `config.yaml`. */
  readonly remove = async (name: string): Promise<void> => {
    const entry = this.#entries.get(name);

    if (entry === undefined) {
      return;
    }

    await entry.queue.run(async () => {
      await this.#stop(name, entry);
      this.#entries.delete(name);
    });
  };

  /** Stops every Agent, all at once. */
  readonly stopAll = async (): Promise<void> => {
    await Promise.all(this.names.map(async (name) => await this.stop(name)));
  };

  readonly #entry = (name: string): Entry<A> => {
    const existing = this.#entries.get(name);

    if (existing !== undefined) {
      return existing;
    }

    const created: Entry<A> = {
      cancelRestart: undefined,
      failures: 0,
      generation: 0,
      instance: undefined,
      lastError: null,
      queue: new SerialQueue(),
      restartAt: null,
      state: "stopped",
    };

    this.#entries.set(name, created);

    return created;
  };

  readonly #setState = (
    name: string,
    entry: Entry<A>,
    state: AgentState
  ): void => {
    entry.state = state;

    const payload: EventPayload<"agent.status"> = { agent: name, state };

    if (state === "degraded" && entry.lastError !== null) {
      payload.error = entry.lastError;
    }

    this.#options.events.emit("agent.status", payload);
  };

  readonly #start = async (
    name: string,
    entry: Entry<A>
  ): Promise<AgentState> => {
    if (entry.state === "running") {
      return entry.state;
    }

    clearRestart(entry);
    entry.generation += 1;
    const { generation } = entry;

    this.#setState(name, entry, "starting");

    try {
      entry.instance = await this.#options.open(name, {
        onFailed: (error) => {
          void this.#fail(name, entry, generation, error);
        },
        onRestartRequested: () => {
          void this.restart(name);
        },
      });
      entry.failures = 0;
      entry.lastError = null;
      this.#setState(name, entry, "running");
    } catch (error) {
      this.#degrade(
        name,
        entry,
        error instanceof Error ? error : new Error(String(error))
      );
    }

    return entry.state;
  };

  readonly #stop = async (
    name: string,
    entry: Entry<A>
  ): Promise<AgentState> => {
    clearRestart(entry);
    entry.generation += 1;

    const { instance } = entry;

    entry.instance = undefined;

    if (instance !== undefined) {
      await this.#close(name, instance);
    }

    if (entry.state !== "stopped") {
      entry.failures = 0;
      this.#setState(name, entry, "stopped");
    }

    return entry.state;
  };

  /** Handles a failure of a running instance: closes it, marks the Agent degraded, and schedules a retry. */
  readonly #fail = async (
    name: string,
    entry: Entry<A>,
    generation: number,
    error: Error
  ): Promise<void> => {
    await entry.queue.run(async () => {
      if (entry.generation !== generation) {
        return;
      }

      const { instance } = entry;

      entry.instance = undefined;
      entry.generation += 1;

      if (instance !== undefined) {
        await this.#close(name, instance);
      }

      this.#degrade(name, entry, error);
    });
  };

  /**
   * Closes an instance and logs a rejection instead of passing it on. Failure callbacks and restart timers start
   * lifecycle work without a caller that awaits it, so a rejection here would go unhandled and leave the state stale.
   */
  readonly #close = async (name: string, instance: A): Promise<void> => {
    try {
      await instance.close();
    } catch (error) {
      this.#options.log.error("The Agent failed to close", {
        agent: name,
        error: errorMessage(error),
      });
    }
  };

  readonly #degrade = (name: string, entry: Entry<A>, error: Error): void => {
    entry.lastError = error.message;
    entry.failures += 1;
    this.#options.log.error("The Agent is degraded", {
      agent: name,
      error: error.message,
      failures: entry.failures,
    });
    this.#setState(name, entry, "degraded");

    const delay = Math.min(
      RESTART_BACKOFF_INITIAL_MS * 2 ** (entry.failures - 1),
      RESTART_BACKOFF_MAX_MS
    );

    const { generation } = entry;

    entry.restartAt = this.#options.clock.now() + delay;
    entry.cancelRestart = this.#setTimer(() => {
      void entry.queue.run(async () => {
        if (entry.generation === generation && entry.state === "degraded") {
          await this.#start(name, entry);
        }
      });
    }, delay);
  };
}
