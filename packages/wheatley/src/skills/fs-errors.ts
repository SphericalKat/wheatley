/** Returns true if `cause` is a Node.js file system error, which carries an errno `code` such as `ENOENT`. */
export const isErrnoException = (
  cause: unknown
): cause is NodeJS.ErrnoException => cause instanceof Error && "code" in cause;

/** Returns true if `cause` reports a missing file or folder. */
export const isNotFound = (cause: unknown): boolean =>
  isErrnoException(cause) && cause.code === "ENOENT";

/** Returns true if `cause` reports a path whose parent is a file, for example `notes.txt/SKILL.md`. */
export const isNotFolder = (cause: unknown): boolean =>
  isErrnoException(cause) && cause.code === "ENOTDIR";

/** The message of a thrown value, for a warning or a Tool error result. */
export const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);
