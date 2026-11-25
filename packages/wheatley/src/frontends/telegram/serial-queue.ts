/**
 * Runs async tasks one at a time, in the order of `run` calls.
 *
 * Invariant: a task starts only after every earlier task settles. A rejected task rejects only for its own caller and
 * does not stop later tasks.
 */
export class SerialQueue {
  #tail: Promise<unknown> = Promise.resolve();

  /** Queues `task` and resolves or rejects with its result. */
  readonly run = async <T>(task: () => Promise<T>): Promise<T> => {
    const previous = this.#tail;

    const current = (async (): Promise<T> => {
      await Promise.allSettled([previous]);

      return await task();
    })();

    this.#tail = current;

    return await current;
  };

  /** Resolves after every task queued so far settles. Never rejects. */
  readonly idle = async (): Promise<void> => {
    await Promise.allSettled([this.#tail]);
  };
}
