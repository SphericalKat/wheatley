/** The message of a thrown value: `Error.message` for an `Error`, otherwise the value as a string. */
export const errorMessage = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- A caught value has no type, and this helper only reads its message.
  error: unknown
): string => (error instanceof Error ? error.message : String(error));
