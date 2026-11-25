import { cp, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

/**
 * The folder of the bundled dashboard assets in the compiled package: `dist/dashboard/`, next to `dist/ops/`. The
 * Control Server serves it on `/`.
 */
export const dashboardAssetsDir = (): string =>
  path.resolve(import.meta.dirname, "..", "dashboard");

/** The Vite build output of `packages/dashboard`, relative to `packages/wheatley`. */
export const DASHBOARD_BUILD_DIR = path.join("..", "dashboard", "dist");

const DASHBOARD_ENTRY = "index.html";

const countFiles = async (dir: string): Promise<number> => {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });

  return entries.filter((entry) => entry.isFile()).length;
};

const hasEntry = async (dir: string): Promise<boolean> => {
  try {
    const info = await stat(path.join(dir, DASHBOARD_ENTRY));

    return info.isFile();
  } catch {
    return false;
  }
};

/**
 * Replaces `targetDir` with a copy of the dashboard build output in `sourceDir` and returns the number of copied
 * files. The `prepack` hook and the Docker image build run it after `pnpm build`.
 *
 * Errors: throws if `sourceDir` has no `index.html`, so a package never ships without its dashboard.
 */
export const bundleDashboardAssets = async (
  sourceDir: string,
  targetDir: string
): Promise<number> => {
  if (!(await hasEntry(sourceDir))) {
    throw new Error(
      `No dashboard build in ${sourceDir}. Build it first: pnpm --filter @wheatley/dashboard run build`
    );
  }

  await rm(targetDir, { force: true, recursive: true });
  await cp(sourceDir, targetDir, { recursive: true });

  return await countFiles(targetDir);
};
