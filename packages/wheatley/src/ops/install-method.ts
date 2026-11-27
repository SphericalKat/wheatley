import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { Type } from "typebox";
import { Value } from "typebox/value";

import type { CommandRunner } from "./command-runner.js";
import { envValue, isDocker, pathExists } from "./paths.js";
import { PACKAGE_NAME } from "./registry.js";

/** The Node.js package managers that can own a global install of Wheatley. */
export const NODE_MANAGERS = ["npm", "pnpm", "yarn", "bun"] as const;

export type NodeManager = (typeof NODE_MANAGERS)[number];

/** The install methods that `wheatley update` updates itself. `wheatley update --method` takes these values. */
export const UPDATE_METHODS = [...NODE_MANAGERS, "brew", "curl"] as const;

export type UpdateMethod = (typeof UPDATE_METHODS)[number];

/** The install methods that another tool owns. `wheatley update` only prints instructions for them. */
export type ExternalMethod = "volta" | "mise" | "aur";

/** How this Wheatley was installed. */
export type InstallMethod = UpdateMethod | ExternalMethod | "docker" | "source";

/** One install of Wheatley. `packageDir` is the real path of the package folder, without symlinks. */
export type Installation =
  | {
      readonly method: "npm";
      readonly packageDir: string;
      /** The program and leading arguments that start the npm of this install, for example `["/p/bin/node", "/p/bin/npm"]`. */
      readonly npm: readonly [string, ...string[]];
      /** The npm prefix that holds the package, so that `npm install --global --prefix` replaces this copy. */
      readonly prefix: string | undefined;
    }
  | {
      readonly method: "brew";
      readonly packageDir: string;
      /** The formula name for `brew upgrade`, for example `sphericalkat/tap/wheatley`. */
      readonly formula: string;
    }
  | {
      readonly method: Exclude<InstallMethod, "npm" | "brew">;
      readonly packageDir: string;
    };

export interface InstallationInput {
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly userHome: string;
  /** The package folder of the running Wheatley. It can contain symlinks. */
  readonly packageDir: string;
  /** The Node.js binary that runs Wheatley. */
  readonly execPath: string;
  /** Runs `pacman` and the global package lists of the Node.js package managers. */
  readonly runner: CommandRunner;
  /** Skips the detection and uses this method, for `wheatley update --method`. */
  readonly method?: UpdateMethod;
}

const TAP_FORMULA = "sphericalkat/tap/wheatley";
const CORE_TAP = "homebrew/core";

const segment = (...names: string[]): string =>
  `${path.sep}${names.join(path.sep)}${path.sep}`;

const PACKAGE_SUFFIX = segment(
  "lib",
  "node_modules",
  ...PACKAGE_NAME.split("/")
);

const ReceiptSchema = Type.Object({
  source: Type.Object({ tap: Type.String() }),
});

/** Returns `true` if `dir` is `parent` or inside it. Both paths must be real paths. */
const isInside = (dir: string, parent: string): boolean =>
  `${dir}${path.sep}`.startsWith(`${parent}${path.sep}`);

/** Returns the real path of `target`, or `target` itself if it does not exist. */
const realOrSelf = async (target: string): Promise<string> => {
  try {
    return await realpath(target);
  } catch {
    return target;
  }
};

const curlAppDirs = (env: NodeJS.ProcessEnv, userHome: string): string[] => {
  const fallback = path.join(userHome, ".local", "share");
  const xdg = envValue(env, "XDG_DATA_HOME");

  return [...new Set([xdg ?? fallback, fallback])].map((dataHome) =>
    path.join(dataHome, "wheatley", "app")
  );
};

const isCurlInstall = async (
  dir: string,
  input: InstallationInput
): Promise<boolean> => {
  const appDirs = await Promise.all(
    curlAppDirs(input.env, input.userHome).map(realOrSelf)
  );

  return appDirs.some((appDir) => isInside(dir, appDir));
};

/** The npm prefix of `<prefix>/lib/node_modules/@wheatley-ai/cli`, which npm uses on POSIX systems. */
const npmPrefix = (
  dir: string,
  platform: NodeJS.Platform
): string | undefined =>
  platform !== "win32" && `${dir}${path.sep}`.endsWith(PACKAGE_SUFFIX)
    ? dir.slice(0, -(PACKAGE_SUFFIX.length - 1))
    : undefined;

/** Reads the tap of the Homebrew keg that holds `dir`, from its `INSTALL_RECEIPT.json`. */
const brewFormula = async (dir: string): Promise<string> => {
  const cellar = segment("Cellar", "wheatley");
  const start = dir.indexOf(cellar) + cellar.length;
  const keg = dir.slice(0, dir.indexOf(path.sep, start));

  try {
    const receipt: unknown = JSON.parse(
      await readFile(path.join(keg, "INSTALL_RECEIPT.json"), "utf-8")
    );

    return Value.Check(ReceiptSchema, receipt) &&
      receipt.source.tap === CORE_TAP
      ? "wheatley"
      : TAP_FORMULA;
  } catch {
    return TAP_FORMULA;
  }
};

/** Returns `true` if `pacman` reports an owner package for `dir`. */
const isPacmanPackage = async (
  dir: string,
  runner: CommandRunner
): Promise<boolean> => {
  try {
    const result = await runner.run("pacman", ["-Qqo", dir]);

    return result.exitCode === 0;
  } catch {
    return false;
  }
};

const AUR_DIR = segment(
  "usr",
  "lib",
  "node_modules",
  ...PACKAGE_NAME.split("/")
);

/** Detects the installs that a dedicated tool or another package system owns, from the real package path. */
const detectManaged = async (
  dir: string,
  input: InstallationInput
): Promise<InstallMethod | undefined> => {
  if (await isCurlInstall(dir, input)) {
    return "curl";
  }

  const hints: readonly (readonly [InstallMethod, string])[] = [
    ["brew", segment("Cellar", "wheatley")],
    ["volta", segment("tools", "image", "packages")],
    ["mise", `${path.sep}installs${path.sep}npm-`],
  ];

  const marked = `${dir}${path.sep}`;
  const hinted = hints.find(([, hint]) => marked.includes(hint))?.[0];

  if (hinted !== undefined) {
    return hinted;
  }

  const isSystemPackage =
    input.platform === "linux" &&
    marked.endsWith(AUR_DIR) &&
    (await isPacmanPackage(dir, input.runner));

  if (isSystemPackage) {
    return "aur";
  }

  return marked.includes(segment("node_modules")) ? undefined : "source";
};

/** The global package folders of each manager, as path fragments. */
const MANAGER_HINTS: Readonly<Record<NodeManager, readonly string[]>> = {
  bun: [segment(".bun", "install", "global")],
  npm: [PACKAGE_SUFFIX],
  pnpm: [segment("pnpm", "global"), segment(".pnpm")],
  yarn: [segment("yarn", "global"), segment("Yarn", "Data", "global")],
};

const PROBES: Readonly<Record<NodeManager, readonly string[]>> = {
  bun: ["pm", "ls", "-g"],
  npm: ["list", "-g", "--depth=0", PACKAGE_NAME],
  pnpm: ["list", "-g", "--depth=0", PACKAGE_NAME],
  yarn: ["global", "list"],
};

/** Resolves `true` if the global package list of `manager` contains Wheatley. A missing manager counts as `false`. */
const listsWheatley = async (
  manager: NodeManager,
  runner: CommandRunner
): Promise<boolean> => {
  try {
    const result = await runner.run(manager, PROBES[manager]);

    return result.exitCode === 0 && result.stdout.includes(PACKAGE_NAME);
  } catch {
    return false;
  }
};

/**
 * Picks the Node.js package manager that owns the install. It ranks the managers by the path of the package, then
 * confirms the ranking with their global package lists, which it queries in parallel.
 */
const detectNodeManager = async (
  dir: string,
  input: InstallationInput
): Promise<NodeManager> => {
  const marked = `${dir}${path.sep}`;
  const pnpmHome = envValue(input.env, "PNPM_HOME");

  const hinted = NODE_MANAGERS.filter(
    (manager) =>
      MANAGER_HINTS[manager].some((hint) => marked.includes(hint)) ||
      (manager === "pnpm" &&
        pnpmHome !== undefined &&
        isInside(dir, path.resolve(pnpmHome)))
  );

  const confirmed = await Promise.all(
    NODE_MANAGERS.map(async (manager) =>
      (await listsWheatley(manager, input.runner)) ? manager : []
    )
  );

  const owners = confirmed.flat();

  return (
    hinted.find((manager) => owners.includes(manager)) ??
    owners[0] ??
    hinted[0] ??
    "npm"
  );
};

/** The npm that belongs to `prefix`, started with the Node.js of the prefix or else the running Node.js. */
const npmFor = async (
  prefix: string | undefined,
  execPath: string
): Promise<readonly [string, ...string[]]> => {
  if (prefix === undefined) {
    return ["npm"];
  }

  const npm = path.join(prefix, "bin", "npm");

  if (!(await pathExists(npm))) {
    return ["npm"];
  }

  const node = path.join(prefix, "bin", "node");

  return [(await pathExists(node)) ? node : await realOrSelf(execPath), npm];
};

const describe = async (
  method: InstallMethod,
  dir: string,
  input: InstallationInput
): Promise<Installation> => {
  if (method === "npm") {
    const prefix = npmPrefix(dir, input.platform);

    return {
      method,
      npm: await npmFor(prefix, input.execPath),
      packageDir: dir,
      prefix,
    };
  }

  if (method === "brew") {
    return { formula: await brewFormula(dir), method, packageDir: dir };
  }

  return { method, packageDir: dir };
};

/**
 * Finds out how this Wheatley was installed and what updates it.
 *
 * It resolves the real package path first, so that a symlink such as `/opt/homebrew/opt/wheatley` or a `pnpm` link
 * cannot hide the owner. It checks in this order:
 *
 * 1. Docker, from `WHEATLEY_DOCKER`.
 * 2. The `curl` installer app folder, `${XDG_DATA_HOME:-~/.local/share}/wheatley/app`.
 * 3. Homebrew, Volta, and mise, from their folders.
 * 4. An AUR package, if `pacman` owns `/usr/lib/node_modules/@wheatley-ai/cli`.
 * 5. A source checkout, if the package is outside `node_modules`.
 * 6. npm, pnpm, yarn, or bun, from the package path and their global package lists.
 *
 * Errors: does not reject. A failed or missing `pacman` or package manager counts as "does not own Wheatley".
 */
export const resolveInstallation = async (
  input: InstallationInput
): Promise<Installation> => {
  const dir = await realOrSelf(input.packageDir);

  if (input.method !== undefined) {
    return await describe(input.method, dir, input);
  }

  if (isDocker(input.env)) {
    return { method: "docker", packageDir: dir };
  }

  const method =
    (await detectManaged(dir, input)) ?? (await detectNodeManager(dir, input));

  return await describe(method, dir, input);
};
