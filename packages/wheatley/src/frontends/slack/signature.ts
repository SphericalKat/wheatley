import { createHmac, timingSafeEqual } from "node:crypto";

/** Slack rejects replays older than five minutes, and so does the binding. */
export const SIGNATURE_MAX_AGE_SECONDS = 300;

const MS_PER_SECOND = 1000;
const TIMESTAMP = /^\d+$/u;

/** The headers that Slack signs a request with. Header names are lowercase. */
export interface SignedRequest {
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

/**
 * Verifies the `x-slack-signature` HMAC-SHA256 signature and the `x-slack-request-timestamp` age of a Slack request.
 *
 * Returns false for a missing header, a timestamp more than `SIGNATURE_MAX_AGE_SECONDS` away from `nowMs`, or a wrong
 * signature. Compares signatures in constant time.
 */
export const verifySlackSignature = (
  request: SignedRequest,
  signingSecret: string,
  nowMs: number
): boolean => {
  const timestamp = request.headers["x-slack-request-timestamp"];
  const signature = request.headers["x-slack-signature"];

  if (
    timestamp === undefined ||
    signature === undefined ||
    !TIMESTAMP.test(timestamp)
  ) {
    return false;
  }

  const ageSeconds = Math.abs(nowMs / MS_PER_SECOND - Number(timestamp));

  if (ageSeconds > SIGNATURE_MAX_AGE_SECONDS) {
    return false;
  }

  const expected = Buffer.from(
    `v0=${createHmac("sha256", signingSecret)
      .update(`v0:${timestamp}:`)
      .update(request.body)
      .digest("hex")}`
  );

  const given = Buffer.from(signature);

  return given.length === expected.length && timingSafeEqual(given, expected);
};
