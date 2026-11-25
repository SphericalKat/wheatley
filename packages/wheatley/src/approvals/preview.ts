import { TOOL_INPUT_PREVIEW_MAX_LENGTH } from "@wheatley/protocol";
import type { JsonValue } from "@wheatley/protocol";

import type { SecretStore } from "../contracts/config-store.js";

const HIGH_SURROGATE_MIN = 0xd8_00;
const HIGH_SURROGATE_MAX = 0xdb_ff;

const endsWithHighSurrogate = (text: string): boolean => {
  const code = text.codePointAt(text.length - 1) ?? 0;

  return code >= HIGH_SURROGATE_MIN && code <= HIGH_SURROGATE_MAX;
};

/**
 * Builds the `inputPreview` of an Approval: the JSON text of the Tool input with every secret value redacted, cut to
 * 500 characters. The cut happens after redaction, so it cannot expose part of a secret, and it never splits a
 * surrogate pair.
 */
export const buildInputPreview = (
  input: JsonValue,
  secrets: Pick<SecretStore, "redact">
): string => {
  const redacted = secrets.redact(JSON.stringify(input));
  const cut = redacted.slice(0, TOOL_INPUT_PREVIEW_MAX_LENGTH);

  return endsWithHighSurrogate(cut) ? cut.slice(0, -1) : cut;
};
