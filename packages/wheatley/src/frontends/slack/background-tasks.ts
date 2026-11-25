/** Promises that run in the background, so that a stop can wait for them. */
export class BackgroundTasks {
  readonly #pending = new Set<Promise<void>>();

  /**
   * Adds a task. The task must never reject: a rejection becomes an unhandled rejection. The task leaves the set
   * when it settles.
   */
  readonly add = (task: Promise<void>): void => {
    this.#pending.add(task);
    void this.#removeWhenDone(task);
  };

  /** Resolves after every task that was added before the call settles. */
  readonly settled = async (): Promise<void> => {
    await Promise.all(this.#pending);
  };

  readonly #removeWhenDone = async (task: Promise<void>): Promise<void> => {
    await task;
    this.#pending.delete(task);
  };
}
