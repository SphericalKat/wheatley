/** The time limit of one request to a search provider. */
export const PROVIDER_TIMEOUT_MS = 25_000;

/** The largest response body that Wheatley reads from a search provider. */
export const MAX_PROVIDER_RESPONSE_BYTES = 256 * 1024;

/** The `User-Agent` header of every request that the Plugin sends. */
export const USER_AGENT =
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; Wheatley/1.0; +https://github.com/SphericalKat/wheatley";

/** A response with a status outside 200-299. */
export class HttpStatusError extends Error {
  readonly status: number;
  /** The `Retry-After` header of the response, if any. */
  readonly retryAfter: string | undefined;

  constructor(label: string, response: Response) {
    super(`${label} failed with HTTP ${response.status}`);
    this.name = "HttpStatusError";
    this.status = response.status;
    this.retryAfter = response.headers.get("retry-after") ?? undefined;
  }
}

/** Throws `HttpStatusError` and releases the body if `response` does not have a 2xx status. */
export const assertOk = async (
  label: string,
  response: Response
): Promise<void> => {
  if (response.ok) {
    return;
  }

  await response.body?.cancel();

  throw new HttpStatusError(label, response);
};

/**
 * Reads the body of `response` as UTF-8 text.
 *
 * Errors: rejects with `tooLarge()` as soon as the declared or the received length exceeds `limit` bytes, and cancels
 * the rest of the body.
 */
export const readTextWithin = async (
  response: Response,
  limit: number,
  tooLarge: () => Error
): Promise<string> => {
  const declared = Number(response.headers.get("content-length"));

  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel();

    throw tooLarge();
  }

  if (response.body === null) {
    return "";
  }

  const chunks: Uint8Array[] = [];
  let size = 0;

  // Leaving the loop early cancels the stream.
  for await (const chunk of response.body) {
    size += chunk.byteLength;

    if (size > limit) {
      throw tooLarge();
    }

    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString("utf-8");
};

/** Returns a signal that aborts with `signal` or after `ms` milliseconds. */
export const withTimeout = (signal: AbortSignal, ms: number): AbortSignal =>
  AbortSignal.any([signal, AbortSignal.timeout(ms)]);
