/**
 * Resolves on a later microtask, like real I/O. In-memory fakes await it before they act, so tests catch callers that
 * do not await a seam call or that rely on synchronous side effects.
 */
export const simulateIo = async (): Promise<void> => {
  await Promise.resolve();
};
