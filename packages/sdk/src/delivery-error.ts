/** How the outbox treats a failed delivery. */
export type DeliveryFailureKind = "retryable" | "permanent";

/** Options for a `DeliveryError`. */
export interface DeliveryErrorOptions {
  readonly kind: DeliveryFailureKind;
  /** The platform's requested wait before a retry, for example from HTTP 429 `Retry-After`. */
  readonly retryAfterMs?: number;
  readonly cause?: unknown;
}

/**
 * The error that `FrontendBinding.deliver` rejects with.
 *
 * `permanent` errors (deleted Chat, removed bot) fail the delivery at once. `retryable` errors (network error, HTTP
 * 5xx or 429, binding restart) retry with backoff (ADR 0010).
 */
export class DeliveryError extends Error {
  override readonly name = "DeliveryError";
  readonly kind: DeliveryFailureKind;
  readonly retryAfterMs: number | undefined;

  constructor(message: string, options: DeliveryErrorOptions) {
    super(message, { cause: options.cause });
    this.kind = options.kind;
    this.retryAfterMs = options.retryAfterMs;
  }
}

/**
 * Returns true if `cause` is a `DeliveryError`.
 *
 * Checks the name and fields instead of `instanceof`, so errors from a Plugin that bundles its own copy of
 * `@wheatley/sdk` also match.
 */
export const isDeliveryError = (cause: unknown): cause is DeliveryError =>
  cause instanceof Error &&
  cause.name === "DeliveryError" &&
  "kind" in cause &&
  (cause.kind === "retryable" || cause.kind === "permanent");
