import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

import { events, isEventName } from "./events.js";
import type { EventName, EventPayload } from "./events.js";
import { isJsonValue } from "./json.js";
import type { JsonValue } from "./json.js";
import { isMethodName, methods } from "./methods.js";
import type { MethodName, MethodParams, MethodResult } from "./methods.js";
import { RpcErrorCode } from "./rpc-error.js";
import type { RpcErrorCodeValue, RpcErrorObject } from "./rpc-error.js";
import { validationIssues } from "./validation.js";

/** A JSON-RPC request ID. Wheatley clients use strings or integers. */
export const RpcIdSchema = Type.Union([
  Type.String({ minLength: 1 }),
  Type.Integer(),
]);

export type RpcId = Static<typeof RpcIdSchema>;

const RequestEnvelope = Type.Object({
  id: RpcIdSchema,
  jsonrpc: Type.Literal("2.0"),
  method: Type.String(),
  params: Type.Optional(
    Type.Union([Type.Object({}), Type.Array(Type.Unknown())])
  ),
});

const WithId = Type.Object({ id: RpcIdSchema });

const ResultEnvelope = Type.Object({
  id: RpcIdSchema,
  jsonrpc: Type.Literal("2.0"),
  result: Type.Unknown(),
});

const ErrorEnvelope = Type.Object({
  error: Type.Object({
    code: Type.Integer(),
    data: Type.Optional(Type.Unknown()),
    message: Type.String(),
  }),
  id: Type.Union([RpcIdSchema, Type.Null()]),
  jsonrpc: Type.Literal("2.0"),
});

const NotificationEnvelope = Type.Object({
  jsonrpc: Type.Literal("2.0"),
  method: Type.String(),
  params: Type.Unknown(),
});

const KNOWN_ERROR_CODES: ReadonlySet<number> = new Set(
  Object.values(RpcErrorCode)
);

/** A decoded request for one method, with params that match its schema. */
export type RpcRequest = {
  [M in MethodName]: {
    readonly id: RpcId;
    readonly method: M;
    readonly params: MethodParams<M>;
  };
}[MethodName];

/** A decoded event notification. */
export type RpcEvent = {
  [E in EventName]: { readonly name: E; readonly payload: EventPayload<E> };
}[EventName];

/** A decoded success response, matched to the method of its request. */
export type RpcResult = {
  [M in MethodName]: {
    readonly id: RpcId;
    readonly method: M;
    readonly result: MethodResult<M>;
  };
}[MethodName];

/** The result of `decodeClientMessage`. On failure, `id` and `error` form the error response to send back. */
export type ClientMessage =
  | { readonly ok: true; readonly request: RpcRequest }
  | {
      readonly ok: false;
      readonly id: RpcId | null;
      readonly error: RpcErrorObject;
    };

/** The result of `decodeServerMessage`. */
export type ServerMessage =
  | { readonly kind: "result"; readonly response: RpcResult }
  | {
      readonly kind: "error";
      readonly id: RpcId | null;
      readonly error: RpcErrorObject;
    }
  | { readonly kind: "event"; readonly event: RpcEvent }
  | { readonly kind: "invalid"; readonly reason: string };

const failure = (
  id: RpcId | null,
  code: RpcErrorCodeValue,
  message: string,
  data?: JsonValue
): ClientMessage => ({
  error: data === undefined ? { code, message } : { code, data, message },
  id,
  ok: false,
});

const parseJson = (
  text: string
):
  | { readonly ok: true; readonly value: JsonValue }
  | { readonly ok: false } => {
  try {
    const value: unknown = JSON.parse(text);

    return isJsonValue(value) ? { ok: true, value } : { ok: false };
  } catch {
    return { ok: false };
  }
};

const isRpcErrorCode = (code: number): code is RpcErrorCodeValue =>
  KNOWN_ERROR_CODES.has(code);

/** Returns true if `candidate.params` match the params schema of `candidate.method`. */
const isRpcRequest = (candidate: {
  readonly id: RpcId;
  readonly method: MethodName;
  readonly params: unknown;
}): candidate is RpcRequest =>
  Value.Check(methods[candidate.method].params, candidate.params);

/** Returns true if `candidate.result` matches the result schema of `candidate.method`. */
const isRpcResult = (candidate: {
  readonly id: RpcId;
  readonly method: MethodName;
  readonly result: unknown;
}): candidate is RpcResult =>
  Value.Check(methods[candidate.method].result, candidate.result);

/** Returns true if `candidate.payload` matches the payload schema of event `candidate.name`. */
const isRpcEvent = (candidate: {
  readonly name: EventName;
  readonly payload: unknown;
}): candidate is RpcEvent =>
  Value.Check(events[candidate.name], candidate.payload);

/**
 * Decodes one client-to-daemon WebSocket message into a request with validated params.
 *
 * Wheatley requires an `id` on every request, accepts object params only, and does not support batches. Absent params
 * decode as `{}`.
 */
export const decodeClientMessage = (text: string): ClientMessage => {
  const parsed = parseJson(text);

  if (!parsed.ok) {
    return failure(null, RpcErrorCode.ParseError, "Parse error");
  }

  const { value } = parsed;

  if (!Value.Check(RequestEnvelope, value)) {
    const id = Value.Check(WithId, value) ? value.id : null;

    return failure(id, RpcErrorCode.InvalidRequest, "Invalid request");
  }

  const { id, method } = value;
  const params = value.params ?? {};

  if (!isMethodName(method)) {
    return failure(
      id,
      RpcErrorCode.MethodNotFound,
      `Method not found: ${method}`
    );
  }

  const request = { id, method, params };

  if (isRpcRequest(request)) {
    return { ok: true, request };
  }

  const issues = isJsonValue(params)
    ? validationIssues(methods[method].params, params)
    : [];

  return failure(id, RpcErrorCode.InvalidParams, "Invalid params", {
    issues: issues.map(({ message, path }) => ({ message, path })),
  });
};

/**
 * Decodes one daemon-to-client WebSocket message.
 *
 * `methodFor` returns the method of a pending request ID, so the result can be validated against that method's result
 * schema. A result for an unknown ID, a result that fails its schema, or an unknown event decodes as `invalid`.
 */
export const decodeServerMessage = (
  text: string,
  methodFor: (id: RpcId) => MethodName | undefined
): ServerMessage => {
  const parsed = parseJson(text);

  if (!parsed.ok) {
    return { kind: "invalid", reason: "Parse error" };
  }

  const { value } = parsed;

  if (Value.Check(ErrorEnvelope, value)) {
    const { code, message } = value.error;
    const data = isJsonValue(value.error.data) ? value.error.data : undefined;
    const errorCode = isRpcErrorCode(code) ? code : RpcErrorCode.InternalError;

    const error: RpcErrorObject =
      data === undefined
        ? { code: errorCode, message }
        : { code: errorCode, data, message };

    return { error, id: value.id, kind: "error" };
  }

  if (Value.Check(ResultEnvelope, value)) {
    const method = methodFor(value.id);

    if (method === undefined) {
      return {
        kind: "invalid",
        reason: `No pending request with ID ${String(value.id)}`,
      };
    }

    const response = { id: value.id, method, result: value.result };

    return isRpcResult(response)
      ? { kind: "result", response }
      : {
          kind: "invalid",
          reason: `Result of ${method} does not match its schema`,
        };
  }

  if (Value.Check(NotificationEnvelope, value) && isEventName(value.method)) {
    const event = { name: value.method, payload: value.params };

    return isRpcEvent(event)
      ? { event, kind: "event" }
      : {
          kind: "invalid",
          reason: `Payload of ${event.name} does not match its schema`,
        };
  }

  return { kind: "invalid", reason: "Unknown message" };
};

/** Encodes a request. */
export const encodeRequest = <M extends MethodName>(
  id: RpcId,
  method: M,
  params: MethodParams<M>
): string => JSON.stringify({ id, jsonrpc: "2.0", method, params });

/**
 * Encodes a success response. Throws if `result` does not match the result schema of `method`, so a handler defect
 * becomes an `InternalError` response instead of a response that clients reject.
 */
export const encodeResult = <M extends MethodName>(
  id: RpcId,
  method: M,
  result: MethodResult<M>
): string => {
  if (!Value.Check(methods[method].result, result)) {
    throw new Error(`Result of ${method} does not match its schema`);
  }

  return JSON.stringify({ id, jsonrpc: "2.0", result });
};

/** Encodes an error response. `id` is `null` if the request ID could not be read. */
export const encodeError = (id: RpcId | null, error: RpcErrorObject): string =>
  JSON.stringify({ error, id, jsonrpc: "2.0" });

/** Encodes an event as a JSON-RPC notification whose method is the event name. */
export const encodeEvent = <E extends EventName>(
  name: E,
  payload: EventPayload<E>
): string => JSON.stringify({ jsonrpc: "2.0", method: name, params: payload });
