import { once } from "node:events";

import {
  decodeServerMessage,
  encodeRequest,
  PROTOCOL_VERSION,
  RpcError,
} from "@wheatley/protocol";
import type {
  MethodName,
  MethodParams,
  MethodResult,
  RpcEvent,
  RpcId,
  RpcResult,
} from "@wheatley/protocol";
import { WebSocket } from "ws";
import type { RawData } from "ws";

/** Where the daemon listens: a WebSocket URL, or a Unix socket path. */
export type DaemonTarget =
  | { readonly url: string }
  | { readonly socketPath: string };

/** The client name in `system.hello`. */
export const CLIENT_NAME = "wheatley-cli";

interface Pending {
  readonly method: MethodName;
  readonly settle: (response: RpcResult | RpcError) => void;
}

const rawText = (data: RawData): string => {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf-8");
  }

  return Buffer.from(
    data instanceof ArrayBuffer ? new Uint8Array(data) : data
  ).toString("utf-8");
};

const isResultOf = <M extends MethodName>(
  response: RpcResult,
  method: M
): response is RpcResult & { readonly result: MethodResult<M> } =>
  response.method === method;

/**
 * A JSON-RPC client of the Control Server (ADR 0005). One connection carries requests, responses, and events in order.
 * `connect` sends `system.hello` before it resolves.
 */
export class DaemonClient {
  readonly #socket: WebSocket;
  readonly #pending = new Map<RpcId, Pending>();
  readonly #listeners = new Set<(event: RpcEvent) => void>();
  #nextId = 1;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.on("message", (data) => {
      this.#onMessage(rawText(data));
    });
    socket.on("close", () => {
      for (const pending of this.#pending.values()) {
        pending.settle(
          new RpcError(-32_603, "The connection to the daemon closed")
        );
      }

      this.#pending.clear();
    });
  }

  /**
   * Opens a connection and greets the daemon. Errors: rejects if the daemon does not answer, and with `RpcError`
   * `ProtocolMismatch` if it speaks another protocol version.
   */
  static async connect(
    target: DaemonTarget,
    version: string
  ): Promise<DaemonClient> {
    const socket =
      "url" in target
        ? new WebSocket(target.url)
        : new WebSocket(`ws+unix://${target.socketPath}:/ws`);

    // `once` rejects if the socket emits `error` first, for example when no daemon listens.
    await once(socket, "open");

    const client = new DaemonClient(socket);

    await client.request("system.hello", {
      client: { name: CLIENT_NAME, version },
      protocolVersion: PROTOCOL_VERSION,
    });

    return client;
  }

  /** Sends one request and resolves with its result. Errors: rejects with the daemon's `RpcError`. */
  readonly request = async <M extends MethodName>(
    method: M,
    params: MethodParams<M>
  ): Promise<MethodResult<M>> => {
    const id = this.#nextId;

    this.#nextId += 1;

    const response = Promise.withResolvers<RpcResult | RpcError>();

    this.#pending.set(id, { method, settle: response.resolve });
    this.#socket.send(encodeRequest(id, method, params));

    const settled = await response.promise;

    if (settled instanceof RpcError) {
      throw settled;
    }

    if (!isResultOf(settled, method)) {
      throw new RpcError(
        -32_603,
        `The daemon answered ${settled.method} for ${method}`
      );
    }

    return settled.result;
  };

  /** Adds an event listener and returns the function that removes it. */
  readonly onEvent = (listener: (event: RpcEvent) => void): (() => void) => {
    this.#listeners.add(listener);

    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** Closes the connection. */
  readonly close = async (): Promise<void> => {
    if (this.#socket.readyState === WebSocket.CLOSED) {
      return;
    }

    const closed = once(this.#socket, "close");

    this.#socket.close();
    await closed;
  };

  readonly #settle = (id: RpcId, response: RpcResult | RpcError): void => {
    const pending = this.#pending.get(id);

    this.#pending.delete(id);
    pending?.settle(response);
  };

  readonly #onMessage = (text: string): void => {
    const message = decodeServerMessage(
      text,
      (id) => this.#pending.get(id)?.method
    );

    if (message.kind === "event") {
      for (const listener of this.#listeners) {
        listener(message.event);
      }

      return;
    }

    if (message.kind === "result") {
      this.#settle(message.response.id, message.response);

      return;
    }

    if (message.kind === "error" && message.id !== null) {
      this.#settle(
        message.id,
        new RpcError(
          message.error.code,
          message.error.message,
          message.error.data
        )
      );
    }
  };
}
