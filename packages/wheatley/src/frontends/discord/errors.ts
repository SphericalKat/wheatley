import { DeliveryError, isDeliveryError } from "@wheatley-ai/sdk";

/**
 * Discord JSON error codes that no retry can fix: Unknown Channel, Unknown Message, Unknown User, Missing Access,
 * Cannot send messages to this user, and Missing Permissions.
 */
const PERMANENT_CODES: ReadonlySet<number> = new Set([
  10_003, 10_008, 10_013, 50_001, 50_007, 50_013,
]);

const HTTP_CLIENT_ERROR_MIN = 400;
const HTTP_SERVER_ERROR_MIN = 500;
const HTTP_REQUEST_TIMEOUT = 408;
const HTTP_TOO_MANY_REQUESTS = 429;

/** The Discord JSON error code for Unknown Message. */
export const UNKNOWN_MESSAGE_CODE = 10_008;

/** A `DiscordAPIError` from `@discordjs/rest`, which carries the Discord JSON error code. */
const hasDiscordCode = (
  cause: unknown
): cause is Error & { readonly code: number } =>
  cause instanceof Error && "code" in cause && typeof cause.code === "number";

/** A `DiscordAPIError` or `HTTPError` from `@discordjs/rest`, which carries the HTTP status. */
const hasHttpStatus = (
  cause: unknown
): cause is Error & { readonly status: number } =>
  cause instanceof Error &&
  "status" in cause &&
  typeof cause.status === "number";

/** A `RateLimitError` from `@discordjs/rest`, which carries the wait in milliseconds. */
const hasRetryAfter = (
  cause: unknown
): cause is Error & { readonly retryAfter: number } =>
  cause instanceof Error &&
  "retryAfter" in cause &&
  typeof cause.retryAfter === "number";

/** Returns the message of an `Error`, or the string form of any other thrown value, for log fields and notes. */
export const errorText = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** Returns the Discord JSON error code of a `DiscordAPIError`, or `undefined` for other errors. */
export const discordErrorCode = (cause: unknown): number | undefined =>
  hasDiscordCode(cause) ? cause.code : undefined;

const isPermanentStatus = (status: number): boolean =>
  status >= HTTP_CLIENT_ERROR_MIN &&
  status < HTTP_SERVER_ERROR_MIN &&
  status !== HTTP_REQUEST_TIMEOUT &&
  status !== HTTP_TOO_MANY_REQUESTS;

const isPermanent = (cause: unknown): boolean => {
  const code = discordErrorCode(cause);

  if (code !== undefined && PERMANENT_CODES.has(code)) {
    return true;
  }

  return hasHttpStatus(cause) && isPermanentStatus(cause.status);
};

/**
 * Classifies a failure of a Discord API call for the outbox.
 *
 * `DiscordAPIError` codes for a deleted Chat, a removed bot, or missing permissions and other HTTP 4xx answers are
 * `permanent`. HTTP 429 (with `retryAfter` from a `RateLimitError`), HTTP 5xx, and network errors are `retryable`. A
 * `DeliveryError` passes through unchanged.
 */
export const toDeliveryError = (
  cause: unknown,
  action: string
): DeliveryError => {
  if (isDeliveryError(cause)) {
    return cause;
  }

  const detail = cause instanceof Error ? `: ${cause.message}` : "";
  const message = `Discord could not ${action}${detail}`;

  if (isPermanent(cause)) {
    return new DeliveryError(message, { cause, kind: "permanent" });
  }

  return new DeliveryError(message, {
    cause,
    kind: "retryable",
    retryAfterMs: hasRetryAfter(cause) ? cause.retryAfter : undefined,
  });
};
