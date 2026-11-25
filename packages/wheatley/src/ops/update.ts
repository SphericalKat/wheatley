import { readFile } from "node:fs/promises";
import path from "node:path";

import { Type } from "typebox";
import { Value } from "typebox/value";

import { describeFailure } from "./command-runner.js";
import type { CommandRunner } from "./command-runner.js";
import { DOCKER_ENV } from "./paths.js";

/** The npm package name of the daemon and CLI. */
export const PACKAGE_NAME = "wheatley";

/** The commands that update a Docker Compose Deployment. Run them in the folder of `docker-compose.yml`. */
export const DOCKER_UPDATE_COMMANDS = [
  "docker compose pull",
  "docker compose up -d",
] as const;

const VERSION =
  /^(?<major>0|[1-9]\d*)\.(?<minor>0|[1-9]\d*)\.(?<patch>0|[1-9]\d*)(?<prerelease>-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

interface Version {
  readonly text: string;
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: boolean;
}

const parseVersion = (text: string): Version | undefined => {
  const groups = VERSION.exec(text)?.groups;

  if (groups === undefined) {
    return undefined;
  }

  return {
    major: Number(groups.major),
    minor: Number(groups.minor),
    patch: Number(groups.patch),
    prerelease: groups.prerelease !== undefined,
    text,
  };
};

/** Orders by major, minor, and patch. A release sorts after a prerelease of the same numbers. */
const compareVersions = (a: Version, b: Version): number =>
  a.major - b.major ||
  a.minor - b.minor ||
  a.patch - b.patch ||
  Number(b.prerelease) - Number(a.prerelease);

const newest = (versions: readonly Version[]): Version | undefined =>
  versions.toSorted(compareVersions).at(-1);

/** The result of the major-version guard. */
export interface UpdateSelection {
  /** The newest release in the current major version that is newer than the current version, if one exists. */
  readonly target: string | undefined;
  /** The newest release in a later major version, if one exists. `wheatley update` never installs it. */
  readonly newerMajor: string | undefined;
}

/**
 * Applies the major-version guard: picks the newest stable release with the same major version as `current` that is
 * newer than `current`. It ignores prereleases and text that is not a version.
 *
 * Errors: throws if `current` is not a semantic version.
 */
export const selectUpdate = (
  current: string,
  available: readonly string[]
): UpdateSelection => {
  const installed = parseVersion(current);

  if (installed === undefined) {
    throw new Error(
      `The installed version is not a semantic version: ${current}`
    );
  }

  const releases = available
    .flatMap((text) => parseVersion(text) ?? [])
    .filter(
      (version) =>
        !version.prerelease && compareVersions(version, installed) > 0
    );

  return {
    newerMajor: newest(
      releases.filter((version) => version.major > installed.major)
    )?.text,
    target: newest(
      releases.filter((version) => version.major === installed.major)
    )?.text,
  };
};

/** How this Wheatley was installed. */
export type InstallMethod = "npm" | "pnpm" | "docker" | "source";

export type PackageManager = "npm" | "pnpm";

const segment = (...names: string[]): string =>
  `${path.sep}${names.join(path.sep)}${path.sep}`;

/**
 * Detects the install method from the environment and the real path of the installed package folder.
 *
 * pnpm keeps global packages in a `pnpm/global/` folder and its store in `.pnpm/`. Any other `node_modules/` folder is
 * an npm install. A folder outside `node_modules/` is a source checkout.
 */
export const detectInstallMethod = (
  env: NodeJS.ProcessEnv,
  packageDir: string
): InstallMethod => {
  if (env[DOCKER_ENV] === "1") {
    return "docker";
  }

  const dir = `${packageDir}${path.sep}`;

  if (
    dir.includes(segment("pnpm", "global")) ||
    dir.includes(segment(".pnpm"))
  ) {
    return "pnpm";
  }

  return dir.includes(segment("node_modules")) ? "npm" : "source";
};

/** The global install command that updates Wheatley to `version`. */
export const installCommand = (
  manager: PackageManager,
  version: string
): readonly [string, ...string[]] =>
  manager === "pnpm"
    ? ["pnpm", "add", "--global", `${PACKAGE_NAME}@${version}`]
    : ["npm", "install", "--global", `${PACKAGE_NAME}@${version}`];

export type UpdatePlan =
  | { readonly kind: "docker"; readonly commands: readonly string[] }
  | {
      readonly kind: "up_to_date";
      readonly current: string;
      readonly newerMajor: string | undefined;
    }
  | {
      readonly kind: "update";
      readonly current: string;
      readonly target: string;
      readonly newerMajor: string | undefined;
      readonly command: readonly [string, ...string[]];
    };

/** `npm view <package> versions --json` prints a string for one version and an array for more. */
const VersionListSchema = Type.Union([
  Type.String(),
  Type.Array(Type.String()),
]);

const PackageJsonSchema = Type.Object({ version: Type.String() });

/** Lists the published versions of the package with `npm view`, which works for npm and pnpm installs. */
const publishedVersions = async (runner: CommandRunner): Promise<string[]> => {
  const args = ["view", PACKAGE_NAME, "versions", "--json"];
  const result = await runner.run("npm", args);

  if (result.exitCode !== 0) {
    throw new Error(describeFailure("npm", args, result));
  }

  const parsed: unknown = JSON.parse(result.stdout);

  if (!Value.Check(VersionListSchema, parsed)) {
    throw new Error("npm view returned an unexpected version list");
  }

  return [parsed].flat();
};

export interface PlanUpdateInput {
  readonly current: string;
  readonly method: InstallMethod;
  /** Overrides the detected package manager. */
  readonly manager?: PackageManager;
  readonly runner: CommandRunner;
}

/**
 * Decides what `wheatley update` does. It never installs anything.
 *
 * - Docker: returns the Docker Compose commands, without a registry query.
 * - npm or pnpm: queries the registry and applies the major-version guard (`selectUpdate`).
 *
 * Errors: throws for a source checkout without a `manager` override, if `npm view` fails, or for an invalid current
 * version.
 */
export const planUpdate = async (
  input: PlanUpdateInput
): Promise<UpdatePlan> => {
  if (input.method === "docker") {
    return { commands: DOCKER_UPDATE_COMMANDS, kind: "docker" };
  }

  const manager =
    input.manager ?? (input.method === "source" ? undefined : input.method);

  if (manager === undefined) {
    throw new Error(
      "This Wheatley runs from a source checkout. Update it with git, or pass --manager npm or --manager pnpm."
    );
  }

  const { newerMajor, target } = selectUpdate(
    input.current,
    await publishedVersions(input.runner)
  );

  if (target === undefined) {
    return { current: input.current, kind: "up_to_date", newerMajor };
  }

  return {
    command: installCommand(manager, target),
    current: input.current,
    kind: "update",
    newerMajor,
    target,
  };
};

/**
 * Runs the install command of an `update` plan with the standard streams attached.
 *
 * Errors: rejects if the package manager cannot start or exits with a non-zero code.
 */
export const applyUpdate = async (
  plan: Extract<UpdatePlan, { kind: "update" }>,
  runner: CommandRunner
): Promise<void> => {
  const [command, ...args] = plan.command;
  const result = await runner.run(command, args, { inheritStdio: true });

  if (result.exitCode !== 0) {
    throw new Error(describeFailure(command, args, result));
  }
};

/** The folder of this package, which holds `package.json`, `bin/`, and `dist/`. */
export const packageDir = (): string =>
  path.resolve(import.meta.dirname, "..", "..");

/** Reads the version of the installed package from its `package.json`. */
export const readPackageVersion = async (
  dir: string = packageDir()
): Promise<string> => {
  const file = path.join(dir, "package.json");
  const parsed: unknown = JSON.parse(await readFile(file, "utf-8"));

  if (!Value.Check(PackageJsonSchema, parsed)) {
    throw new Error(`No version in ${file}`);
  }

  return parsed.version;
};
