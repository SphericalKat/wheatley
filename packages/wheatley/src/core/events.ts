import type { EventName, EventPayload } from "@wheatley-ai/protocol";

import type { EventSink } from "../contracts/module.js";

/** Receives every emitted event. It must not throw or block. */
export type BusListener = <E extends EventName>(
  name: E,
  payload: EventPayload<E>
) => void;

/**
 * The Deployment-wide event bus. Modules emit through it as an `EventSink`, and each Control Server connection
 * listens and filters by its subscriptions. Listeners run synchronously in subscription order. A throwing listener is
 * skipped, so one connection cannot block another.
 */
export class EventBus implements EventSink {
  readonly #listeners = new Set<BusListener>();

  readonly emit = <E extends EventName>(
    name: E,
    payload: EventPayload<E>
  ): void => {
    for (const listener of this.#listeners) {
      try {
        listener(name, payload);
      } catch {
        // A listener failure must not reach the emitter or other listeners.
      }
    }
  };

  /** Adds a listener and returns the function that removes it. */
  readonly listen = (listener: BusListener): (() => void) => {
    this.#listeners.add(listener);

    return () => {
      this.#listeners.delete(listener);
    };
  };
}
