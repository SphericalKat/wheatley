import { readFile } from "node:fs/promises";
import path from "node:path";

import semver from "semver";
import { Type } from "typebox";
import { Value } from "typebox/value";

import { describeFailure } from "./command-runner.js";
import type { CommandRunner } from "./command-runner.js";
import type { Installation } from "./install-method.js";
import { fetchPublishedVersions, PACKAGE_NAME } from "./registry.js";
import type { FetchFn } from "./registry.js";

/** The commands that update a Docker Compose Deployment. Run them in the folder of `docker-compose.yml`. */
export const DOCKER_UPDATE_COMMANDS = [
  "docker compose pull",
  "docker compose up -d",
] as const;

/** The `curl` installer. Run again with `--version`, it replaces the app in its XDG folder. */
export const INSTALLER_URL =
  "https://raw.githubusercontent.com/SphericalKat/wheatley/main/scripts/install.sh";

const BUILD_METADATA = /\+.*$/u;

/**
 * Accepts only canonical semantic versions. `semver.valid` also accepts a `v` prefix and white space, and drops build
 * metadata from its result, so the text without build metadata must equal the normalized version.
 */
const isVersion = (text: string): boolean =>
  semver.valid(text) === text.replace(BUILD_METADATA, "");

const isStable = (text: string): boolean => semver.prerelease(text) === null;

const newest = (versions: readonly string[]): string | undefined =>
  versions.toSorted(semver.rcompare).at(0);

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
  if (!isVersion(current)) {
    throw new Error(
      `The installed version is not a semantic version: ${current}`
    );
  }

  const installedMajor = semver.major(current);

  const releases = available.filter(
    (text) => isVersion(text) && isStable(text) && semver.gt(text, current)
  );

  return {
    newerMajor: newest(
      releases.filter((text) => semver.major(text) > installedMajor)
    ),
    target: newest(
      releases.filter((text) => semver.major(text) === installedMajor)
    ),
  };
};

/** A command that updates this Wheatley in place. */
export interface CommandAction {
  readonly kind: "command";
  readonly command: readonly [string, ...string[]];
  /**
   * `true` if the command replaces the package folder that runs now, so that `applyUpgrade` can check its version.
   * pnpm installs each version into a new folder, and Homebrew and the `curl` installer pick their own folders.
   */
  readonly verify: boolean;
}

/** Instructions for an install that another tool owns. `wheatley update` does not change it. */
export interface NoticeAction {
  readonly kind: "notice";
  readonly lines: readonly string[];
}

export type UpgradeAction = CommandAction | NoticeAction;

const command = (
  verify: boolean,
  ...parts: readonly [string, ...string[]]
): CommandAction => ({ command: parts, kind: "command", verify });

const notice = (...lines: string[]): NoticeAction => ({
  kind: "notice",
  lines,
});

/**
 * Returns what updates `installation` to `version`.
 *
 * Errors: throws for a Docker install or a source checkout, which `planUpdate` handles before the registry query.
 */
export const upgradeAction = (
  installation: Installation,
  version: string
): UpgradeAction => {
  const spec = `${PACKAGE_NAME}@${version}`;

  switch (installation.method) {
    case "npm": {
      const prefix =
        installation.prefix === undefined
          ? []
          : ["--prefix", installation.prefix];

      return command(
        true,
        ...installation.npm,
        "install",
        "--global",
        ...prefix,
        spec
      );
    }

    case "pnpm": {
      return command(false, "pnpm", "add", "--global", spec);
    }

    case "yarn": {
      return command(true, "yarn", "global", "add", spec);
    }

    case "bun": {
      return command(true, "bun", "install", "--global", spec);
    }

    case "brew": {
      return command(false, "brew", "upgrade", installation.formula);
    }

    case "curl": {
      // The script is downloaded before it runs, so that a failed download fails the command. A pipe from `curl` to
      // `sh` would exit 0. The URL and version are arguments, not shell text.
      return command(
        false,
        "sh",
        "-c",
        'script="$(curl -fsSL "$0")" && printf "%s\\n" "$script" | sh -s -- --version "$1" --no-modify-path',
        INSTALLER_URL,
        version
      );
    }

    case "volta": {
      return notice(
        "Volta manages this Wheatley. To update it, run:",
        `  volta install ${spec}`
      );
    }

    case "mise": {
      return notice(
        "mise manages this Wheatley. To update it, run:",
        `  mise use -g npm:${spec}`
      );
    }

    case "aur": {
      return notice(
        "This Wheatley is the AUR package wheatley-cli. Update it with your AUR helper, for example:",
        "  paru -Syu",
        "  yay -Syu"
      );
    }

    case "docker":
    case "source": {
      throw new Error(
        `wheatley update cannot update a ${installation.method} install`
      );
    }

    default: {
      const unknown: never = installation;

      throw new Error(`Unknown installation: ${JSON.stringify(unknown)}`);
    }
  }
};

/** A release in a later major version and what installs it. `wheatley update` only reports it. */
export interface NewerMajor {
  readonly version: string;
  readonly action: UpgradeAction;
}

export type UpdatePlan =
  | { readonly kind: "docker"; readonly commands: readonly string[] }
  | {
      readonly kind: "up_to_date";
      readonly current: string;
      readonly newerMajor: NewerMajor | undefined;
    }
  | {
      readonly kind: "update";
      readonly current: string;
      readonly target: string;
      readonly action: UpgradeAction;
      readonly newerMajor: NewerMajor | undefined;
    };

const PackageJsonSchema = Type.Object({ version: Type.String() });

export interface PlanUpdateInput {
  readonly current: string;
  readonly installation: Installation;
  /** Reads `npm_config_registry` for the registry query. */
  readonly env: NodeJS.ProcessEnv;
  readonly fetch: FetchFn;
}

/**
 * Decides what `wheatley update` does. It never installs anything.
 *
 * - Docker: returns the Docker Compose commands, without a registry query.
 * - Any other install: queries the registry, applies the major-version guard (`selectUpdate`), and returns the
 *   `upgradeAction` of the target version.
 *
 * Errors: throws for a source checkout, if the registry query fails, or for an invalid current version.
 */
export const planUpdate = async (
  input: PlanUpdateInput
): Promise<UpdatePlan> => {
  const { installation } = input;

  if (installation.method === "docker") {
    return { commands: DOCKER_UPDATE_COMMANDS, kind: "docker" };
  }

  if (installation.method === "source") {
    throw new Error(
      "This Wheatley runs from a source checkout. Update it with git, or pass --method npm|pnpm|yarn|bun|brew|curl."
    );
  }

  const { newerMajor, target } = selectUpdate(
    input.current,
    await fetchPublishedVersions(input)
  );

  const major =
    newerMajor === undefined
      ? undefined
      : {
          action: upgradeAction(installation, newerMajor),
          version: newerMajor,
        };

  if (target === undefined) {
    return { current: input.current, kind: "up_to_date", newerMajor: major };
  }

  return {
    action: upgradeAction(installation, target),
    current: input.current,
    kind: "update",
    newerMajor: major,
    target,
  };
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

export interface ApplyUpgradeOptions {
  readonly runner: CommandRunner;
  /** The real path of the package folder that runs now. */
  readonly packageDir: string;
  readonly target: string;
  /** The working folder of the command, outside any project, for example the user home folder. */
  readonly workDir: string;
}

/**
 * Runs an upgrade command with the standard streams attached. If `action.verify` is `true`, it then reads
 * `package.json` in `packageDir` again, because a package manager can exit with code 0 but update another copy.
 *
 * Errors: rejects if the command cannot start, exits with a non-zero code, or leaves the running copy on another
 * version than `target`.
 */
export const applyUpgrade = async (
  action: CommandAction,
  options: ApplyUpgradeOptions
): Promise<void> => {
  const [program, ...args] = action.command;

  // Corepack shims of pnpm and yarn refuse to run inside a project whose `packageManager` names another manager.
  const result = await options.runner.run(program, args, {
    cwd: options.workDir,
    inheritStdio: true,
  });

  if (result.exitCode !== 0) {
    throw new Error(describeFailure(program, args, result));
  }

  if (!action.verify) {
    return;
  }

  const installed = await readPackageVersion(options.packageDir);

  if (installed !== options.target) {
    throw new Error(
      `${action.command.join(" ")} finished, but ${options.packageDir} still has Wheatley ${installed}, not ${options.target}. Another copy of Wheatley can be first on PATH, or pass --method to name the package manager that owns this copy.`
    );
  }
};
