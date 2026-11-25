import {
  decodeServerMessage,
  encodeRequest,
  PROTOCOL_VERSION,
  RpcError,
  RpcErrorCode,
} from "@wheatley/protocol";
import type {
  EventName,
  EventPayload,
  MethodName,
  MethodParams,
  MethodResult,
  RpcEvent,
  RpcId,
  RpcResult,
} from "@wheatley/protocol";

import { createStore } from "../store.js";
import type { Store } from "../store.js";

/**
 * The connection state of the client.
 *
 * - `connecting`: the first connection attempt runs.
 * - `open`: `system.hello` and `events.subscribe` succeeded. Calls go out at once.
 * - `reconnecting`: the connection closed, and the client waits to try again. Calls wait.
 * - `closed`: `close` was called. Calls fail.
 * - `incompatible`: the daemon speaks another protocol version. Calls fail, and the client does not reconnect.
 */
export type ConnectionStatus =
  | "connecting"
  | "open"
  | "reconnecting"
  | "closed"
  | "incompatible";

/** What the dashboard shows about its daemon connection. */
export interface ClientState {
  readonly status: ConnectionStatus;
  /** The daemon version from `system.hello`, or `null` before the first handshake. */
  readonly wheatleyVersion: string | null;
  /** The last connection or protocol problem, or `null`. */
  readonly lastError: string | null;
  /** The number of requests that wait for a response. */
  readonly pending: number;
  /** Counts successful handshakes. It increases by one for each connection. */
  readonly connection: number;
}

/** Settings of `createRpcClient`. */
export interface RpcClientOptions {
  /** The WebSocket URL of the daemon, for example `ws://127.0.0.1:7420/ws`. */
  readonly url: string;
  readonly clientName: string;
  readonly clientVersion: string;
  /** Opens a socket. The default is the global `WebSocket`. */
  readonly createSocket?: (url: string) => WebSocket;
  /** The first delay before a reconnect. Each failed attempt doubles it up to `maxReconnectDelayMs`. */
  readonly reconnectDelayMs?: number;
  readonly maxReconnectDelayMs?: number;
}

/** A JSON-RPC 2.0 client for the Wheatley control protocol (ADR 0005). */
export interface RpcClient {
  readonly state: Store<ClientState>;
  /**
   * Opens the connection, then sends `system.hello` and `events.subscribe` for every topic and Agent. Does nothing if
   * the client already connects or is open. After a lost connection, the client reconnects with backoff until `close`.
   */
  readonly connect: () => void;
  /** Closes the connection for good. Pending and waiting calls reject. */
  readonly close: () => void;
  /**
   * Sends one request and resolves with its validated result.
   *
   * Ordering: a call made before the handshake completes waits for it. Responses arrive before the events that the
   * request caused (ADR 0005).
   *
   * Errors: rejects with `RpcError` for a JSON-RPC error response, and with `Error` if the connection closes before
   * the response, the client is closed or incompatible, or the result does not match the method's result schema.
   */
  readonly call: <M extends MethodName>(
    method: M,
    params: MethodParams<M>
  ) => Promise<MethodResult<M>>;
  /**
   * Calls `listener` with the payload of every `name` event. Payloads already match their schema. Returns a function
   * that removes the listener.
   */
  readonly on: <E extends EventName>(
    name: E,
    listener: (payload: EventPayload<E>) => void
  ) => () => void;
  /**
   * Calls `listener` after each successful handshake, also after a reconnect, so views can reload state that they
   * missed while offline. Returns a function that removes the listener.
   */
  readonly onReady: (listener: () => void) => () => void;
}

const DEFAULT_RECONNECT_DELAY_MS = 500;
const DEFAULT_MAX_RECONNECT_DELAY_MS = 10_000;
const NORMAL_CLOSURE = 1000;

interface PendingRequest {
  readonly method: MethodName;
  readonly resolve: (response: RpcResult) => void;
  readonly reject: (cause: Error) => void;
}

interface Waiter {
  readonly resolve: (ready: true) => void;
  readonly reject: (cause: Error) => void;
}

/** Returns the `/ws` URL on the origin that served the dashboard. */
export const dashboardSocketUrl = (location: URL): string => {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";

  return `${protocol}//${location.host}/ws`;
};

/** Rethrows a listener error outside the message loop, so one failing view does not stop the others. */
const reportListenerError = (cause: unknown): void => {
  queueMicrotask(() => {
    throw cause;
  });
};

/** Creates a client. It stays idle until `connect`. */
export const createRpcClient = (options: RpcClientOptions): RpcClient => {
  const createSocket =
    options.createSocket ?? ((url: string) => new WebSocket(url));

  const firstDelay = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;

  const maxDelay =
    options.maxReconnectDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY_MS;

  const state = createStore<ClientState>({
    connection: 0,
    lastError: null,
    pending: 0,
    status: "connecting",
    wheatleyVersion: null,
  });

  const pending = new Map<RpcId, PendingRequest>();
  const eventListeners = new Map<EventName, Set<(event: RpcEvent) => void>>();
  const readyListeners = new Set<() => void>();
  let waiters: Waiter[] = [];
  let socket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let delay = firstDelay;
  let nextId = 1;
  let stopped = false;

  const patch = (change: Partial<ClientState>): void => {
    state.update((current) => ({ ...current, ...change }));
  };

  const syncPending = (): void => {
    patch({ pending: pending.size });
  };

  const rejectPending = (cause: Error): void => {
    const requests = [...pending.values()];

    pending.clear();
    syncPending();

    for (const request of requests) {
      request.reject(cause);
    }
  };

  const rejectWaiters = (cause: Error): void => {
    const current = waiters;

    waiters = [];

    for (const waiter of current) {
      waiter.reject(cause);
    }
  };

  const terminalError = (): Error | null => {
    const { status, lastError } = state.get();

    if (status === "closed") {
      return new Error("The dashboard closed its daemon connection");
    }

    if (status === "incompatible") {
      return new Error(
        lastError ?? "The daemon speaks another protocol version"
      );
    }

    return null;
  };

  const whenReady = async (): Promise<void> => {
    if (state.get().status === "open") {
      return;
    }

    const terminal = terminalError();

    if (terminal !== null) {
      throw terminal;
    }

    const { promise, reject, resolve } = Promise.withResolvers<true>();

    waiters.push({ reject, resolve });
    await promise;
  };

  /** Sends a request on the current socket without the handshake gate. */
  const send = async <M extends MethodName>(
    method: M,
    params: MethodParams<M>
  ): Promise<MethodResult<M>> => {
    const current = socket;

    if (current === null || current.readyState !== WebSocket.OPEN) {
      throw new Error("The daemon connection is not open");
    }

    const id = nextId;

    nextId += 1;

    const { promise, reject, resolve } = Promise.withResolvers<RpcResult>();

    pending.set(id, { method, reject, resolve });
    syncPending();
    current.send(encodeRequest(id, method, params));

    const response = await promise;

    // SAFETY: decodeServerMessage validated `result` against the result schema of the method stored for this ID,
    // and that method is M.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- TypeScript cannot correlate the RpcResult union with M.
    return response.result as MethodResult<M>;
  };

  const settle = (id: RpcId): PendingRequest | undefined => {
    const request = pending.get(id);

    if (request !== undefined) {
      pending.delete(id);
      syncPending();
    }

    return request;
  };

  const dispatchEvent = (event: RpcEvent): void => {
    const listeners = eventListeners.get(event.name);

    if (listeners === undefined) {
      return;
    }

    for (const listener of listeners) {
      try {
        listener(event);
      } catch (error) {
        reportListenerError(error);
      }
    }
  };

  const handleMessage = (text: string): void => {
    let resultId: RpcId | undefined;

    const message = decodeServerMessage(text, (id) => {
      resultId = id;

      return pending.get(id)?.method;
    });

    if (message.kind === "result") {
      settle(message.response.id)?.resolve(message.response);

      return;
    }

    if (message.kind === "event") {
      dispatchEvent(message.event);

      return;
    }

    if (message.kind === "error") {
      const { code, data, message: description } = message.error;
      const request = message.id === null ? undefined : settle(message.id);

      if (request === undefined) {
        patch({ lastError: `The daemon reported an error: ${description}` });

        return;
      }

      request.reject(new RpcError(code, description, data));

      return;
    }

    const request = resultId === undefined ? undefined : settle(resultId);

    if (request === undefined) {
      patch({ lastError: `Ignored a daemon message: ${message.reason}` });

      return;
    }

    request.reject(new Error(message.reason));
  };

  const markOpen = (wheatleyVersion: string): void => {
    delay = firstDelay;
    patch({
      connection: state.get().connection + 1,
      lastError: null,
      status: "open",
      wheatleyVersion,
    });

    const current = waiters;

    waiters = [];

    for (const waiter of current) {
      waiter.resolve(true);
    }

    for (const listener of readyListeners) {
      try {
        listener();
      } catch (error) {
        reportListenerError(error);
      }
    }
  };

  const handshake = async (): Promise<void> => {
    try {
      const hello = await send("system.hello", {
        client: { name: options.clientName, version: options.clientVersion },
        protocolVersion: PROTOCOL_VERSION,
      });

      if (hello.protocolVersion !== PROTOCOL_VERSION) {
        throw new RpcError(
          RpcErrorCode.ProtocolMismatch,
          `The daemon speaks protocol version ${hello.protocolVersion}, but the dashboard speaks ${PROTOCOL_VERSION}`
        );
      }

      await send("events.subscribe", {});
      markOpen(hello.wheatleyVersion);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      const incompatible =
        error instanceof RpcError &&
        error.code === RpcErrorCode.ProtocolMismatch;

      if (incompatible) {
        patch({ lastError: message, status: "incompatible" });
        rejectWaiters(new Error(message));
        socket?.close(NORMAL_CLOSURE);

        return;
      }

      patch({ lastError: `Handshake failed: ${message}` });
      socket?.close(NORMAL_CLOSURE);
    }
  };

  const scheduleReconnect = (): void => {
    if (stopped || state.get().status === "incompatible") {
      return;
    }

    patch({ status: "reconnecting" });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      open();
    }, delay);
    delay = Math.min(delay * 2, maxDelay);
  };

  const open = (): void => {
    if (stopped || socket !== null) {
      return;
    }

    let current: WebSocket;

    try {
      current = createSocket(options.url);
    } catch (error) {
      patch({
        lastError: error instanceof Error ? error.message : String(error),
      });
      scheduleReconnect();

      return;
    }

    socket = current;
    current.addEventListener("open", () => {
      void handshake();
    });
    current.addEventListener("message", (event: MessageEvent<string>) => {
      handleMessage(event.data);
    });
    current.addEventListener("close", () => {
      if (socket !== current) {
        return;
      }

      socket = null;
      rejectPending(new Error("The daemon connection closed"));
      scheduleReconnect();
    });
  };

  return {
    call: async (method, params) => {
      await whenReady();

      return await send(method, params);
    },
    close: () => {
      stopped = true;

      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }

      const current = socket;

      socket = null;
      current?.close(NORMAL_CLOSURE);

      if (state.get().status !== "incompatible") {
        patch({ status: "closed" });
      }

      const cause =
        terminalError() ?? new Error("The dashboard closed its connection");

      rejectPending(cause);
      rejectWaiters(cause);
    },
    connect: open,
    on: (name, listener) => {
      const wrapped = (event: RpcEvent): void => {
        // SAFETY: the client calls this wrapper only for events named `name`, and decodeServerMessage validated
        // the payload against the schema of that event.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- TypeScript cannot correlate the RpcEvent union with E.
        listener(event.payload as EventPayload<typeof name>);
      };

      const listeners = eventListeners.get(name) ?? new Set();

      listeners.add(wrapped);
      eventListeners.set(name, listeners);

      return () => {
        listeners.delete(wrapped);
      };
    },
    onReady: (listener) => {
      readyListeners.add(listener);

      return () => {
        readyListeners.delete(listener);
      };
    },
    state,
  };
};
