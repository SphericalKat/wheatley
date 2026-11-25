import type { MemoryFile } from "@wheatley-ai/protocol";

import { memoryFileName } from "./names.js";

/** Returns the message of a thrown value. */
export const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** Formats one inventory line of a Memory file, for example `- travel.md: 13 characters`. */
export const fileSizeLine = (file: MemoryFile): string =>
  `- ${memoryFileName(file.name)}: ${file.chars} characters`;
