import { createRpcClient } from "../src/rpc/client.js";
import type { RpcClient } from "../src/rpc/client.js";
import { startMockDaemon } from "./server.js";
import type { ListeningMockDaemon } from "./server.js";

/** A mock daemon and dashboard clients connected to it, for tests. */
export interface Harness {
  readonly daemon: ListeningMockDaemon;
  /** Opens one more client, for example a second dashboard tab. It resolves after the handshake. */
  readonly connect: () => Promise<RpcClient>;
  /** Closes every client and the daemon. */
  readonly close: () => Promise<void>;
}

const RECONNECT_DELAY_MS = 5;
const MAX_RECONNECT_DELAY_MS = 20;

/** Starts a mock daemon with fresh fixture data. */
export const startHarness = async (): Promise<Harness> => {
  const daemon = await startMockDaemon();
  const clients: RpcClient[] = [];

  return {
    close: async () => {
      for (const client of clients) {
        client.close();
      }

      await daemon.close();
    },
    connect: async () => {
      const client = createRpcClient({
        clientName: "dashboard-test",
        clientVersion: "1.0.0",
        maxReconnectDelayMs: MAX_RECONNECT_DELAY_MS,
        reconnectDelayMs: RECONNECT_DELAY_MS,
        url: daemon.url,
      });

      clients.push(client);

      const ready = Promise.withResolvers<true>();

      const off = client.onReady(() => {
        off();
        ready.resolve(true);
      });

      client.connect();
      await ready.promise;

      return client;
    },
    daemon,
  };
};
