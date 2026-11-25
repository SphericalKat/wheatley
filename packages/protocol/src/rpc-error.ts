import type { JsonValue } from "./json.js";

/** JSON-RPC 2.0 error codes, plus Wheatley codes in the server error range. */
export const RpcErrorCode = {
  /** An Agent is stopped or degraded. */
  AgentUnavailable: -32_002,
  AgentNotFound: -32_001,
  /** The config is invalid. `data.issues` lists `ConfigIssue` values. */
  ConfigInvalid: -32_005,
  /** The target already exists or is busy, for example `agents.create` for an existing name. */
  Conflict: -32_007,
  InternalError: -32_603,
  InvalidParams: -32_602,
  InvalidRequest: -32_600,
  /** A `MEMORY.md` write exceeds the character cap. */
  MemoryBudgetExceeded: -32_006,
  MethodNotFound: -32_601,
  /** An Approval, Run, Trigger, Memory file, secret, or delivery does not exist. */
  NotFound: -32_004,
  ParseError: -32_700,
  /** The client and daemon speak different protocol versions. */
  ProtocolMismatch: -32_000,
  /** `expectedRevision` does not match the current `config.yaml`. `data.revision` is the current revision. */
  RevisionConflict: -32_003,
} as const;

/** A JSON-RPC error code. */
export type RpcErrorCodeValue =
  (typeof RpcErrorCode)[keyof typeof RpcErrorCode];

/** The `error` member of a JSON-RPC error response. */
export interface RpcErrorObject {
  readonly code: RpcErrorCodeValue;
  readonly message: string;
  readonly data?: JsonValue;
}

/**
 * An error that a JSON-RPC handler throws to send a specific error response. The router sends any other thrown error
 * as `InternalError` without its message.
 */
export class RpcError extends Error {
  override readonly name = "RpcError";
  readonly code: RpcErrorCodeValue;
  readonly data: JsonValue | undefined;

  constructor(code: RpcErrorCodeValue, message: string, data?: JsonValue) {
    super(message);
    this.code = code;
    this.data = data;
  }

  /** The error as a JSON-RPC `error` member. */
  toObject(): RpcErrorObject {
    return this.data === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, data: this.data, message: this.message };
  }
}
