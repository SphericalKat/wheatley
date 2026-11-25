import type { MemorySnapshot } from "../contracts/memory-store.js";

/**
 * Formats a snapshot as the Memory section of the system prompt. Returns an empty string for an empty `MEMORY.md`.
 */
export const formatSnapshotPrompt = (snapshot: MemorySnapshot): string => {
  if (snapshot.text.trim() === "") {
    return "";
  }

  const note = snapshot.truncated
    ? "\n\n(MEMORY.md is longer than its character cap. The text above is cut. Shorten MEMORY.md with memory_write.)"
    : "";

  return `# Memory (MEMORY.md)\n\nThese are your saved notes. Use memory_search and memory_read for topic files and past Conversations.\n\n${snapshot.text}${note}`;
};
