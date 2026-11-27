import type { EventName, EventPayload } from "@wheatley-ai/protocol";

import type { RpcClient } from "../rpc/client.js";

type Listener = (payload: never) => void;

/** A test client that reads results from `client` but delivers them only after `release()`, so they are stale. */
export interface HoldClient {
  readonly client: RpcClient;
  /** Delivers the results of the held calls. */
  readonly release: () => void;
  /** Sends an event to the listeners of the model. */
  readonly emit: <E extends EventName>(
    name: E,
    payload: EventPayload<E>
  ) => void;
}

/** Wraps `client`: calls of the methods in `held` resolve only after `release()`. Events come from `emit` only. */
export const holdClient = (
  client: RpcClient,
  held: readonly string[]
): HoldClient => {
  const listeners = new Map<string, Set<Listener>>();
  const { promise: opened, resolve: gate } = Promise.withResolvers<undefined>();

  const wrapped: RpcClient = {
    ...client,
    call: async (method, params) => {
      const result = await client.call(method, params);

      if (held.includes(method)) {
        await opened;
      }

      return result;
    },
    on: (name, listener) => {
      const set = listeners.get(name) ?? new Set<Listener>();

      set.add(listener);
      listeners.set(name, set);

      return () => {
        set.delete(listener);
      };
    },
  };

  return {
    client: wrapped,
    emit: (name, payload) => {
      for (const listener of listeners.get(name) ?? []) {
        // oxlint-disable-next-line anti-slop/no-reflect-apply -- listeners of `name` take the payload of `name`
        Reflect.apply(listener, undefined, [payload]);
      }
    },
    release: () => {
      gate(undefined);
    },
  };
};
