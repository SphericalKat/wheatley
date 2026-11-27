import { once } from "node:events";
import { chmod, rm } from "node:fs/promises";
import { Server } from "node:http";
import type { IncomingMessage } from "node:http";
import { isIPv4 } from "node:net";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

import { createAdaptorServer } from "@hono/node-server";
import type { Logger } from "@wheatley-ai/sdk";
import { Hono } from "hono";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";

import { errorMessage } from "../error-message.js";
import type { EventBus } from "../events.js";
import type { Router } from "../rpc/router.js";
import { Connection } from "./connection.js";
import { mountStaticFiles } from "./static-files.js";

/** The WebSocket path of the JSON-RPC protocol (ADR 0005). */
export const WS_PATH = "/ws";

/** The file mode of the Unix socket: the owner only (ADR 0002). */
export const SOCKET_FILE_MODE = 0o600;

const PLAIN_TEXT = { "content-type": "text/plain; charset=utf-8" } as const;

/** Hosts whose origins count as the listener's own. */
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"] as const;

/** True for a host name or address that only the local machine can reach: `localhost`, `127.0.0.0/8`, or `::1`. */
export const isLoopbackHost = (host: string): boolean => {
  const bare =
    host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;

  return (
    bare.toLowerCase() === "localhost" ||
    bare === "::1" ||
    (isIPv4(bare) && bare.startsWith("127."))
  );
};

/** Options of `ControlServer.listen`. */
export interface ControlServerOptions {
  /**
   * The TCP host. Keep it on a loopback address: the protocol has no login (ADR 0002). Another host logs a warning but
   * still listens, because a Docker container must listen on all interfaces for a loopback port mapping on the host.
   */
  readonly host: string;
  /** The TCP port, or 0 for any free port. */
  readonly port: number;
  /** A Unix socket path to listen on as well. */
  readonly socketPath?: string;
  /** Browser origins allowed to open `/ws` besides the listener's own origins. */
  readonly allowedOrigins: readonly string[];
  readonly router: Router;
  readonly events: EventBus;
  /** The Wheatley version for `system.hello`. */
  readonly version: string;
  readonly log: Logger;
  /** The bundled dashboard folder that the TCP listener serves on `/`. Without it, `/` answers with a plain text note. */
  readonly staticDir?: string;
}

/**
 * The localhost Control Server: HTTP plus the JSON-RPC WebSocket at `/ws` (ADR 0005). It listens on a loopback TCP
 * port and, if set, on an owner-only Unix socket.
 *
 * Browser requests must come from the listener's own origin or from `allowedOrigins`. The server rejects every other
 * `Origin` with `403`, so a web page cannot drive the daemon. Clients without an `Origin` header, such as the CLI, pass.
 */
export class ControlServer {
  readonly #options: ControlServerOptions;
  readonly #wss = new WebSocketServer({ noServer: true });
  readonly #servers: Server[] = [];
  readonly #connections = new Map<WebSocket, Connection>();
  readonly #app: Hono;
  #port = 0;

  private constructor(options: ControlServerOptions) {
    this.#options = options;
    this.#app = this.#createApp();
  }

  /** Starts to listen. Rejects if the port or the socket path is not available. */
  static async listen(options: ControlServerOptions): Promise<ControlServer> {
    const server = new ControlServer(options);
    const tcp = server.#createHttpServer(true);

    tcp.listen(options.port, options.host);
    await onceListening(tcp);
    server.#port = portOf(tcp);

    if (!isLoopbackHost(options.host)) {
      options.log.warn(
        "The Control Server listens on a host that is not loopback. The protocol has no login: limit access with a firewall, a proxy, or a loopback port mapping.",
        { host: options.host }
      );
    }

    if (options.socketPath !== undefined) {
      await rm(options.socketPath, { force: true });
      const unix = server.#createHttpServer(false);

      unix.listen(options.socketPath);
      await onceListening(unix);
      await chmod(options.socketPath, SOCKET_FILE_MODE);
    }

    return server;
  }

  /** The TCP port. */
  get port(): number {
    return this.#port;
  }

  /** The WebSocket URL on the TCP listener. */
  get url(): string {
    const host = this.#options.host.includes(":")
      ? `[${this.#options.host}]`
      : this.#options.host;

    return `ws://${host}:${this.#port}${WS_PATH}`;
  }

  /** Closes every connection and both listeners. */
  readonly close = async (): Promise<void> => {
    for (const socket of this.#connections.keys()) {
      socket.terminate();
    }

    await Promise.all(
      this.#servers.map(async (server) => {
        server.closeAllConnections();
        const closed = once(server, "close");

        server.close();
        await closed;
      })
    );

    this.#wss.close();

    if (this.#options.socketPath !== undefined) {
      await rm(this.#options.socketPath, { force: true });
    }
  };

  readonly #createHttpServer = (checkOrigin: boolean): Server => {
    const server = createAdaptorServer({
      fetch: this.#app.fetch,
      // The default replaces the global `Request` and `Response` for the whole process.
      overrideGlobalObjects: false,
    });

    if (!(server instanceof Server)) {
      throw new TypeError(
        "The Control Server listener is not an HTTP/1.1 server"
      );
    }

    server.on("upgrade", (request, socket, head) => {
      this.#upgrade(request, socket, head, checkOrigin);
    });
    this.#servers.push(server);

    return server;
  };

  readonly #createApp = (): Hono => {
    const app = new Hono();
    const { staticDir } = this.#options;

    if (staticDir !== undefined) {
      mountStaticFiles(app, staticDir);
    }

    app.get("/", (c) =>
      c.body(
        `Wheatley daemon. Connect with JSON-RPC over WebSocket at ${WS_PATH}.\n`,
        200,
        PLAIN_TEXT
      )
    );
    app.notFound((c) => c.body("Not found\n", 404, PLAIN_TEXT));
    app.onError((failure, c) => {
      this.#options.log.warn("A dashboard file could not be served", {
        error: errorMessage(failure),
      });

      return c.body("Not found\n", 404, PLAIN_TEXT);
    });

    return app;
  };

  readonly #allowedOrigin = (origin: string): boolean => {
    const own = [this.#options.host, ...LOOPBACK_HOSTS].map((host) => {
      const bracketed =
        host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;

      return `http://${bracketed}:${this.#port}`;
    });

    return (
      own.includes(origin) || this.#options.allowedOrigins.includes(origin)
    );
  };

  readonly #upgrade = (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    checkOrigin: boolean
  ): void => {
    const { pathname } = new URL(request.url ?? "/", "http://localhost");
    const { origin } = request.headers;

    if (pathname !== WS_PATH) {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");

      return;
    }

    if (checkOrigin && origin !== undefined && !this.#allowedOrigin(origin)) {
      this.#options.log.warn("Rejected a WebSocket from a foreign origin", {
        origin,
      });
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");

      return;
    }

    this.#wss.handleUpgrade(request, socket, head, (ws) => {
      this.#connections.set(ws, new Connection(ws, this.#options));
      ws.on("close", () => {
        this.#connections.delete(ws);
      });
    });
  };
}

const onceListening = async (server: Server): Promise<void> => {
  // `once` rejects if the server emits `error` first, for example for a port in use.
  await once(server, "listening");
};

const isAddressInfo = (
  address: AddressInfo | string | null
): address is AddressInfo => address !== null && typeof address === "object";

const portOf = (server: Server): number => {
  const address = server.address();

  return isAddressInfo(address) ? address.port : 0;
};
