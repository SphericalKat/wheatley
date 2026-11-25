/** A value that changes over time and notifies listeners. React views read it with `useStore`. */
export interface Store<State> {
  /** Returns the current state. The same object is returned until the next change. */
  readonly get: () => State;
  /** Replaces the state and notifies every listener, unless `next` is the current state. */
  readonly set: (next: State) => void;
  /** Replaces the state with the result of `change` and notifies every listener. */
  readonly update: (change: (current: State) => State) => void;
  /** Calls `listener` after each change. Returns a function that removes the listener. */
  readonly subscribe: (listener: () => void) => () => void;
}

/** Creates a store with `initial` as its first state. */
export const createStore = <State>(initial: State): Store<State> => {
  let state = initial;
  const listeners = new Set<() => void>();

  const set = (next: State): void => {
    if (Object.is(next, state)) {
      return;
    }

    state = next;

    for (const listener of listeners) {
      listener();
    }
  };

  return {
    get: () => state,
    set,
    subscribe: (listener) => {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    update: (change) => {
      set(change(state));
    },
  };
};

/** Returns the message of an error for display. */
export const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);
