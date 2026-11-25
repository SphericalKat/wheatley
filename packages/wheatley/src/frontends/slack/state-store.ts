import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Logger } from "@wheatley/sdk";

import type { ApprovalRecord } from "./schemas.js";
import { decodeOptional, parseJsonText, StateFileSchema } from "./schemas.js";

export type { ApprovalRecord } from "./schemas.js";

/** The file in `FrontendContext.dataDir` that keeps the binding state across daemon restarts. */
export const STATE_FILE = "slack-state.json";

/** The number of engaged threads that the binding remembers. It forgets the oldest thread first. */
const MAX_THREADS = 1000;

/** The number of ended Approvals that the binding remembers to drop duplicate `approval_resolved` deliveries. */
const MAX_RESOLVED_APPROVALS = 500;

const readState = async (file: string): Promise<string | undefined> => {
  try {
    return await readFile(file, "utf-8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
};

/**
 * The persistent state of one Slack binding: the message of each Approval prompt, and the threads where the bot takes
 * part. Map insertion order is age order, so the store drops the oldest entries first.
 */
export class SlackStateStore {
  readonly #file: string;
  readonly #log: Logger;
  readonly #approvals = new Map<string, ApprovalRecord>();
  readonly #threads = new Set<string>();
  #writes: Promise<void> = Promise.resolve();

  private constructor(dataDir: string, log: Logger) {
    this.#file = path.join(dataDir, STATE_FILE);
    this.#log = log;
  }

  /**
   * Reads the state file of a binding. A missing file gives an empty state. A corrupt file also gives an empty state
   * and logs a warning, so a bad file never stops the binding. Rejects only if the file exists but cannot be read.
   */
  static readonly load = async (
    dataDir: string,
    log: Logger
  ): Promise<SlackStateStore> => {
    const store = new SlackStateStore(dataDir, log);
    const text = await readState(store.#file);

    if (text === undefined) {
      return store;
    }

    const state = decodeOptional(StateFileSchema, parseJsonText(text));

    if (state === undefined) {
      log.warn("Ignored a corrupt Slack state file", { path: store.#file });

      return store;
    }

    for (const [approvalId, record] of Object.entries(state.approvals)) {
      store.#approvals.set(approvalId, record);
    }

    for (const chatId of state.threads) {
      store.#threads.add(chatId);
    }

    return store;
  };

  readonly approval = (approvalId: string): ApprovalRecord | undefined =>
    this.#approvals.get(approvalId);

  /** Stores the prompt message of an Approval and persists the state. Never rejects. */
  readonly putApproval = async (
    approvalId: string,
    record: ApprovalRecord
  ): Promise<void> => {
    this.#approvals.delete(approvalId);
    this.#approvals.set(approvalId, record);
    this.#pruneResolved();
    await this.#persist();
  };

  readonly isEngaged = (chatId: string): boolean => this.#threads.has(chatId);

  /** Remembers that the bot takes part in a thread Chat, so replies in it need no mention. Never rejects. */
  readonly engage = async (chatId: string): Promise<void> => {
    if (this.#threads.has(chatId)) {
      return;
    }

    this.#threads.add(chatId);

    for (const oldest of this.#threads) {
      if (this.#threads.size <= MAX_THREADS) {
        break;
      }

      this.#threads.delete(oldest);
    }

    await this.#persist();
  };

  /** Resolves after every started write finished. */
  readonly flush = async (): Promise<void> => {
    await this.#writes;
  };

  readonly #pruneResolved = (): void => {
    const resolved = [...this.#approvals].filter(
      ([, record]) => record.resolved
    );

    const excess = Math.max(0, resolved.length - MAX_RESOLVED_APPROVALS);

    for (const [approvalId] of resolved.slice(0, excess)) {
      this.#approvals.delete(approvalId);
    }
  };

  /** Queues a snapshot write after the previous write. Never rejects. */
  readonly #persist = async (): Promise<void> => {
    const snapshot = JSON.stringify({
      approvals: Object.fromEntries(this.#approvals),
      threads: [...this.#threads],
    });

    this.#writes = this.#write(this.#writes, snapshot);
    await this.#writes;
  };

  /** Writes to a temporary file and renames it, so a crash never leaves a partial file. */
  readonly #write = async (
    previous: Promise<void>,
    snapshot: string
  ): Promise<void> => {
    await previous;
    const temporary = `${this.#file}.tmp`;

    try {
      await writeFile(temporary, snapshot, "utf-8");
      await rename(temporary, this.#file);
    } catch (error) {
      this.#log.error("Could not write the Slack state file", {
        error: String(error),
        path: this.#file,
      });
    }
  };
}
