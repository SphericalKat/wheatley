import { randomUUID } from "node:crypto";

import {
  decodeClientMessage,
  encodeError,
  encodeEvent,
  encodeResult,
  eventTopic,
  PROTOCOL_VERSION,
  RpcError,
  RpcErrorCode,
} from "@wheatley-ai/protocol";
import type {
  EventName,
  EventPayload,
  EventTopic,
  MethodName,
  RpcErrorObject,
  RpcId,
  RpcRequest,
} from "@wheatley-ai/protocol";
import type { Logger } from "@wheatley-ai/sdk";
import type { RawData, WebSocket } from "ws";

import { SeamError, toRpcError } from "../../contracts/errors.js";
import type { RpcContext } from "../../contracts/module.js";
import { errorMessage } from "../error-message.js";
import type { EventBus } from "../events.js";
import type { RoutedRequest, Router } from "../rpc/router.js";

/** What a connection needs from the Control Server. */
export interface ConnectionOptions {
  readonly router: Router;
  readonly events: EventBus;
  /** The Wheatley version for `system.hello`. */
  readonly version: string;
  readonly log: Logger;
}

interface Subscription {
  readonly agents: ReadonlySet<string> | undefined;
  readonly topics: ReadonlySet<EventTopic> | undefined;
}

/** The Agent that an event belongs to, or `undefined` for a Deployment-wide event. */
const eventAgent = <E extends EventName>(
  name: E,
  payload: EventPayload<E>
): string | undefined => {
  if (hasAgent(payload)) {
    return payload.agent;
  }

  return name === "log.record" && hasRecordAgent(payload)
    ? payload.record.agent
    : undefined;
};

const hasAgent = (
  payload: EventPayload<EventName>
): payload is EventPayload<EventName> & { readonly agent: string } =>
  "agent" in payload && typeof payload.agent === "string";

const hasRecordAgent = (
  payload: EventPayload<EventName>
): payload is EventPayload<"log.record"> & {
  readonly record: { readonly agent: string };
} => "record" in payload && typeof payload.record.agent === "string";

const matches = (
  subscription: Subscription,
  topic: EventTopic,
  agent: string | undefined
): boolean =>
  (subscription.topics === undefined || subscription.topics.has(topic)) &&
  (subscription.agents === undefined ||
    agent === undefined ||
    subscription.agents.has(agent));

const errorObject = (
  error: Error,
  log: Logger,
  method: string
): RpcErrorObject => {
  if (error instanceof RpcError) {
    return error.toObject();
  }

  if (error instanceof SeamError) {
    return toRpcError(error).toObject();
  }

  log.error("A JSON-RPC handler failed", {
    error: error.message,
    method,
  });

  return { code: RpcErrorCode.InternalError, message: "Internal error" };
};

const rawText = (data: RawData): string => {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf-8");
  }

  return Buffer.from(
    data instanceof ArrayBuffer ? new Uint8Array(data) : data
  ).toString("utf-8");
};

/**
 * One WebSocket connection: its `system.hello` state, its event subscriptions, and the ordering rule of ADR 0005.
 *
 * Ordering: while any request of the connection runs, the connection holds back events, and sends them after the
 * response. Thus a client never sees the events of a Run before the reply to the request that started it.
 */
export class Connection {
  readonly id = randomUUID();
  readonly #socket: WebSocket;
  readonly #options: ConnectionOptions;
  readonly #abort = new AbortController();
  readonly #subscriptions = new Map<string, Subscription>();
  readonly #held: string[] = [];
  readonly #stopListening: () => void;
  #inFlight = 0;
  #greeted = false;

  constructor(socket: WebSocket, options: ConnectionOptions) {
    this.#socket = socket;
    this.#options = options;
    this.#stopListening = options.events.listen(this.#onEvent);
    socket.on("message", (data) => {
      void this.#onMessage(rawText(data));
    });
    socket.on("close", () => {
      this.#abort.abort(new Error("The connection closed"));
      this.#stopListening();
    });
  }

  readonly #send = (text: string): void => {
    if (this.#socket.readyState === this.#socket.OPEN) {
      this.#socket.send(text);
    }
  };

  readonly #onEvent = <E extends EventName>(
    name: E,
    payload: EventPayload<E>
  ): void => {
    const topic = eventTopic(name);
    const agent = eventAgent(name, payload);

    if (
      ![...this.#subscriptions.values()].some((subscription) =>
        matches(subscription, topic, agent)
      )
    ) {
      return;
    }

    const text = encodeEvent(name, payload);

    if (this.#inFlight > 0) {
      this.#held.push(text);
    } else {
      this.#send(text);
    }
  };

  readonly #onMessage = async (text: string): Promise<void> => {
    const decoded = decodeClientMessage(text);

    if (!decoded.ok) {
      this.#send(encodeError(decoded.id, decoded.error));

      return;
    }

    this.#inFlight += 1;

    try {
      this.#send(await this.#respond(decoded.request));
    } finally {
      this.#inFlight -= 1;

      if (this.#inFlight === 0) {
        for (const event of this.#held.splice(0)) {
          this.#send(event);
        }
      }
    }
  };

  readonly #respond = async (request: RpcRequest): Promise<string> => {
    try {
      if (request.method === "system.hello") {
        this.#hello(request.params.protocolVersion);

        return encodeResult(request.id, "system.hello", {
          protocolVersion: PROTOCOL_VERSION,
          wheatleyVersion: this.#options.version,
        });
      }

      if (!this.#greeted) {
        return encodeError(request.id, {
          code: RpcErrorCode.InvalidRequest,
          message: "The first request of a connection must be system.hello",
        });
      }

      if (request.method === "events.subscribe") {
        const subscriptionId = randomUUID();

        this.#subscriptions.set(subscriptionId, {
          agents:
            request.params.agents === undefined
              ? undefined
              : new Set(request.params.agents),
          topics:
            request.params.topics === undefined
              ? undefined
              : new Set(request.params.topics),
        });

        return encodeResult(request.id, "events.subscribe", { subscriptionId });
      }

      if (request.method === "events.unsubscribe") {
        return encodeResult(request.id, "events.unsubscribe", {
          removed: this.#subscriptions.delete(request.params.subscriptionId),
        });
      }

      return await this.#dispatch(request.id, request);
    } catch (error) {
      return encodeError(
        request.id,
        errorObject(
          error instanceof Error ? error : new Error(String(error)),
          this.#options.log,
          request.method
        )
      );
    }
  };

  /** Accepts `system.hello`. Throws `ProtocolMismatch` for another protocol version. */
  readonly #hello = (protocolVersion: number): void => {
    if (protocolVersion !== PROTOCOL_VERSION) {
      throw new RpcError(
        RpcErrorCode.ProtocolMismatch,
        `The daemon speaks protocol version ${PROTOCOL_VERSION}, and the client speaks ${protocolVersion}`,
        { protocolVersion: PROTOCOL_VERSION }
      );
    }

    this.#greeted = true;
  };

  readonly #dispatch = async <M extends MethodName>(
    id: RpcId,
    request: RoutedRequest<M>
  ): Promise<string> => {
    const ctx: RpcContext = {
      connectionId: this.id,
      signal: this.#abort.signal,
    };

    const result = await this.#options.router.dispatch(request, ctx);

    try {
      return encodeResult(id, request.method, result);
    } catch (error) {
      this.#options.log.error("A JSON-RPC result does not match its schema", {
        error: errorMessage(error),
        method: request.method,
      });

      return encodeError(id, {
        code: RpcErrorCode.InternalError,
        message: "Internal error",
      });
    }
  };
}
