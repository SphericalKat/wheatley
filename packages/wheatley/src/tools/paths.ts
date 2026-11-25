import path from "node:path";

/**
 * Resolves a Tool path against the Agent's workspace. A relative path resolves inside `workspaceDir`, and an absolute
 * path stays as it is. The Permission Policy, not the path, limits what a Tool may touch (ADR 0011).
 */
export const resolveToolPath = (workspaceDir: string, target: string): string =>
  path.resolve(workspaceDir, target);
