import type { GatePressure } from "@wheatley-ai/protocol";

/** The slot limit of a provider credential without `maxConcurrent` in `config.yaml`. */
export const DEFAULT_PROVIDER_CONCURRENCY = 4;

/** One held slot. */
export interface GateLease {
  /** Frees the slot and admits the next waiter. Repeated calls do nothing. */
  readonly release: () => void;
}

interface Waiter {
  readonly grant: (lease: GateLease) => void;
  readonly refuse: (error: Error) => void;
}

interface KeyState {
  inUse: number;
  readonly waiting: Waiter[];
}

/**
 * Limits concurrent model requests per provider credential across every Agent of the Deployment (ADR 0001). Each key
 * is one provider entry of `config.yaml`. Waiters get slots in FIFO order.
 *
 * Invariant: `inUse` never exceeds the key's limit at the moment a slot is granted. A lower limit applies as slots free
 * up; it never revokes a held slot.
 */
export class ConcurrencyGate {
  readonly #limitOf: (key: string) => number;
  readonly #keys = new Map<string, KeyState>();

  /** `limitOf` returns the current limit of a key. The gate reads it on every grant, so config changes apply live. */
  constructor(limitOf: (key: string) => number) {
    this.#limitOf = limitOf;
  }

  /**
   * Resolves with a lease once a slot of `key` is free. Waiters are served in call order.
   *
   * Errors: rejects with the abort reason if `signal` aborts first. The waiter then leaves the queue and takes no slot.
   */
  readonly acquire = async (
    key: string,
    signal?: AbortSignal
  ): Promise<GateLease> => {
    signal?.throwIfAborted();
    const state = this.#state(key);

    if (state.waiting.length === 0 && state.inUse < this.#limit(key)) {
      return this.#grant(key, state);
    }

    const { promise, resolve, reject } = Promise.withResolvers<GateLease>();
    const waiter: Waiter = { grant: resolve, refuse: reject };

    const onAbort = (): void => {
      const index = state.waiting.indexOf(waiter);

      if (index !== -1) {
        state.waiting.splice(index, 1);
        reject(
          signal?.reason instanceof Error
            ? signal.reason
            : new Error("The wait for a model slot was aborted")
        );
      }
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    state.waiting.push(waiter);

    try {
      return await promise;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  };

  /** The use of every key that has held or waited for a slot, sorted by key. */
  readonly pressure = (): GatePressure[] =>
    [...this.#keys.entries()]
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([credential, state]) => ({
        credential,
        inUse: state.inUse,
        limit: this.#limit(credential),
        waiting: state.waiting.length,
      }));

  readonly #limit = (key: string): number =>
    Math.max(1, Math.floor(this.#limitOf(key)));

  readonly #state = (key: string): KeyState => {
    const existing = this.#keys.get(key);

    if (existing !== undefined) {
      return existing;
    }

    const created: KeyState = { inUse: 0, waiting: [] };

    this.#keys.set(key, created);

    return created;
  };

  readonly #grant = (key: string, state: KeyState): GateLease => {
    state.inUse += 1;
    let released = false;

    return {
      release: () => {
        if (released) {
          return;
        }

        released = true;
        state.inUse -= 1;
        this.#drain(key, state);
      },
    };
  };

  readonly #drain = (key: string, state: KeyState): void => {
    while (state.waiting.length > 0 && state.inUse < this.#limit(key)) {
      const next = state.waiting.shift();

      next?.grant(this.#grant(key, state));
    }
  };
}
