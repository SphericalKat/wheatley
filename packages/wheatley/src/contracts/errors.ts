import { RpcError, RpcErrorCode } from "@wheatley/protocol";
import type { JsonValue, RpcErrorCodeValue } from "@wheatley/protocol";

/** Why a seam method failed. Each code maps to one JSON-RPC error code. */
export type SeamErrorCode =
  /** `expectedRevision` does not match `config.yaml` on disk. `details.revision` is the current revision. */
  | "revision_conflict"
  /** A config or secrets file fails validation. `details.issues` lists `ConfigIssue` values. */
  | "config_invalid"
  /** A `MEMORY.md` write would exceed the character cap. */
  | "memory_budget_exceeded"
  /** A name breaks its pattern, for example a Memory slug with `..`. */
  | "invalid_name"
  /** No Agent has this name. */
  | "agent_not_found"
  /** The Approval, Trigger, Run, Memory file, secret, or delivery does not exist. */
  | "not_found"
  /** The target already exists or is in a state that forbids the change. */
  | "conflict"
  /** The caller may not make this change, for example an Agent that creates a `webhook` Trigger. */
  | "forbidden"
  /** The Agent is stopped or degraded. */
  | "agent_unavailable";

/**
 * The error that seam methods throw for expected failures. Seam methods throw other errors only for defects and I/O
 * failures; the JSON-RPC router reports those as `InternalError`.
 */
export class SeamError extends Error {
  override readonly name = "SeamError";
  readonly code: SeamErrorCode;
  readonly details: JsonValue | undefined;

  constructor(code: SeamErrorCode, message: string, details?: JsonValue) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

const RPC_CODES = {
  agent_not_found: RpcErrorCode.AgentNotFound,
  agent_unavailable: RpcErrorCode.AgentUnavailable,
  config_invalid: RpcErrorCode.ConfigInvalid,
  conflict: RpcErrorCode.Conflict,
  forbidden: RpcErrorCode.InvalidParams,
  invalid_name: RpcErrorCode.InvalidParams,
  memory_budget_exceeded: RpcErrorCode.MemoryBudgetExceeded,
  not_found: RpcErrorCode.NotFound,
  revision_conflict: RpcErrorCode.RevisionConflict,
} as const satisfies Record<SeamErrorCode, RpcErrorCodeValue>;

/** Converts a `SeamError` into the `RpcError` that a JSON-RPC handler throws. */
export const toRpcError = (error: SeamError): RpcError =>
  new RpcError(RPC_CODES[error.code], error.message, error.details);
