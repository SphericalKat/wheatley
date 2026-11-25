import type { RpcClient } from "../rpc/client.js";

/**
 * Calls `load` after each handshake of `client`, and once now if the client is already open. A model that loads this
 * way picks up the events that it missed while offline. Returns a function that removes the listener.
 */
export const loadOnReady = (
  client: RpcClient,
  load: () => void
): (() => void) => {
  const off = client.onReady(load);

  if (client.state.get().status === "open") {
    load();
  }

  return off;
};

/** Returns a function that calls each of `offs` once, in order. Models use it to remove their listeners. */
export const disposeAll =
  (offs: readonly (() => void)[]): (() => void) =>
  () => {
    for (const off of offs) {
      off();
    }
  };
