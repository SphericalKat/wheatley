import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import type { Plugin } from "vite";

import type { MockDaemon } from "./server.js";

interface MockModule {
  readonly createMockDaemon: () => MockDaemon;
}

/** A module that Vite loaded through its SSR pipeline. */
// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- Vite types every SSR module as Record<string, any>.
type SsrModule = Readonly<Record<string, unknown>>;

const isMockModule = (
  candidate: SsrModule
): candidate is SsrModule & MockModule =>
  Object.hasOwn(candidate, "createMockDaemon");

/**
 * Serves the mock daemon on `/ws` of the Vite dev server, so `pnpm dev` runs the dashboard against fixture data. The
 * production build does not include it.
 */
export const mockServerPlugin = (): Plugin => ({
  apply: "serve",
  configureServer: async (server) => {
    const { httpServer } = server;

    if (httpServer === null) {
      return;
    }

    // The SSR pipeline resolves `@wheatley/protocol` from source. A static import would make Vite bundle the mock into
    // the config file, which needs the protocol package built first.
    const loaded = await server.ssrLoadModule("/mock/server.ts");

    if (!isMockModule(loaded)) {
      throw new Error("mock/server.ts does not export createMockDaemon");
    }

    const daemon = loaded.createMockDaemon();

    httpServer.on(
      "upgrade",
      (request: IncomingMessage, socket: Duplex, head: Buffer) => {
        daemon.handleUpgrade(request, socket, head);
      }
    );
    httpServer.on("close", () => {
      daemon.close();
    });
  },
  name: "wheatley-mock-daemon",
});
