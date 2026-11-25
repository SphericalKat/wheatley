import { DeliveryError, isDeliveryError } from "@wheatley/sdk";
import type { DeliveryErrorOptions } from "@wheatley/sdk";

const MS_PER_SECOND = 1000;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVER_ERROR = 500;

/** Slack platform errors that a retry cannot fix: a deleted Chat, a removed bot, or a revoked token. */
const PERMANENT_PLATFORM_ERRORS: ReadonlySet<string> = new Set([
  "account_inactive",
  "cannot_dm_bot",
  "channel_not_found",
  "invalid_auth",
  "is_archived",
  "message_not_found",
  "missing_scope",
  "msg_too_long",
  "no_text",
  "not_allowed_token_type",
  "not_authed",
  "not_in_channel",
  "restricted_action",
  "team_access_not_granted",
  "thread_not_found",
  "token_expired",
  "token_revoked",
  "user_not_found",
]);

/** `@slack/web-api` errors for bad file upload arguments or an unreadable file. */
const PERMANENT_CODES: ReadonlySet<string> = new Set([
  "slack_webapi_file_upload_invalid_args_error",
  "slack_webapi_file_upload_read_file_data_error",
]);

/** `WebAPIRateLimitedError` of `@slack/web-api`. */
interface RateLimitedError extends Error {
  readonly code: "slack_webapi_rate_limited_error";
  readonly retryAfter: number;
}

/** `WebAPIPlatformError` of `@slack/web-api`. */
interface PlatformError extends Error {
  readonly code: "slack_webapi_platform_error";
  readonly data: { readonly error: string };
}

/** `WebAPIHTTPError` of `@slack/web-api`. */
interface HttpError extends Error {
  readonly code: "slack_webapi_http_error";
  readonly statusCode: number;
}

/** Any `@slack/web-api` error. Errors match by `code`, because the package loads lazily. */
interface CodedError extends Error {
  readonly code: string;
}

const isCodedError = (cause: unknown): cause is CodedError =>
  cause instanceof Error && "code" in cause && typeof cause.code === "string";

const isRateLimited = (cause: unknown): cause is RateLimitedError =>
  isCodedError(cause) &&
  cause.code === "slack_webapi_rate_limited_error" &&
  "retryAfter" in cause &&
  typeof cause.retryAfter === "number";

const isPlatformError = (cause: unknown): cause is PlatformError =>
  isCodedError(cause) &&
  cause.code === "slack_webapi_platform_error" &&
  "data" in cause &&
  typeof cause.data === "object" &&
  cause.data !== null &&
  "error" in cause.data &&
  typeof cause.data.error === "string";

const isHttpError = (cause: unknown): cause is HttpError =>
  isCodedError(cause) &&
  cause.code === "slack_webapi_http_error" &&
  "statusCode" in cause &&
  typeof cause.statusCode === "number";

const failure = (cause: unknown, permanent: boolean): DeliveryErrorOptions => ({
  cause,
  kind: permanent ? "permanent" : "retryable",
});

const classify = (cause: unknown): DeliveryErrorOptions => {
  if (isRateLimited(cause)) {
    return {
      cause,
      kind: "retryable",
      retryAfterMs: cause.retryAfter * MS_PER_SECOND,
    };
  }

  if (isPlatformError(cause)) {
    return failure(cause, PERMANENT_PLATFORM_ERRORS.has(cause.data.error));
  }

  if (isHttpError(cause)) {
    const retryable =
      cause.statusCode === HTTP_TOO_MANY_REQUESTS ||
      cause.statusCode >= HTTP_SERVER_ERROR;

    return failure(cause, !retryable);
  }

  return failure(cause, isCodedError(cause) && PERMANENT_CODES.has(cause.code));
};

/**
 * Converts an error from a Slack client call into the `DeliveryError` that `FrontendBinding.deliver` rejects with.
 *
 * Rate limits are retryable with the `Retry-After` wait. Platform errors for a deleted Chat, a removed bot, or a bad
 * token are permanent. Network errors, HTTP 5xx, and unknown errors are retryable.
 */
export const toDeliveryError = (cause: unknown): DeliveryError => {
  if (isDeliveryError(cause)) {
    return cause;
  }

  const detail = cause instanceof Error ? cause.message : String(cause);

  return new DeliveryError(`Slack delivery failed: ${detail}`, classify(cause));
};
