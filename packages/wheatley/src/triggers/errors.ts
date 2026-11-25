/** The message of a caught value, for logs and Tool results. */
export const errorText = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);
