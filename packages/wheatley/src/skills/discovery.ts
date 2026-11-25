import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import type { SkillInfo } from "@wheatley/protocol";

import { isNotFolder, isNotFound, messageOf } from "./fs-errors.js";
import { parseSkillFile, SKILL_FILE_NAME } from "./skill-file.js";
import type { SkillFile } from "./skill-file.js";

/** The maximum size of a `SKILL.md` file. A larger file is skipped with a warning. */
export const SKILL_FILE_MAX_BYTES = 256 * 1024;

/** Where a Skill comes from. */
export type SkillOrigin = SkillInfo["origin"];

/** One folder that holds Skill folders. */
export interface SkillRoot {
  readonly origin: SkillOrigin;
  /** The absolute path of the `skills/` folder. */
  readonly dir: string;
}

/** A Skill that passed discovery. */
export interface DiscoveredSkill {
  readonly info: SkillInfo;
  /** The absolute path of the Skill folder. */
  readonly dir: string;
  readonly file: SkillFile;
}

/** The result of `discoverSkills`. */
export interface Discovery {
  /** Loaded Skills, sorted by name. */
  readonly skills: readonly DiscoveredSkill[];
  /** One entry for each skipped `SKILL.md` file or unreadable `skills/` folder. */
  readonly warnings: readonly string[];
}

/** The result of `readSkillFile`. */
export type SkillFileRead =
  | { readonly ok: true; readonly file: SkillFile }
  | { readonly ok: false; readonly reason: string };

/** The result of loading one candidate Skill folder. */
type FolderLoad =
  | { readonly kind: "skill"; readonly skill: DiscoveredSkill }
  | { readonly kind: "warning"; readonly warning: string }
  | { readonly kind: "none" };

/**
 * Reads and parses the `SKILL.md` file of the Skill folder `dir`, whose base name is `folderName`.
 *
 * Returns `ok: false` with a reason that completes the sentence "SKILL.md ..." for a file that is too large or
 * invalid. Rejects for I/O errors, for example a missing file.
 */
export const readSkillFile = async (
  dir: string,
  folderName: string
): Promise<SkillFileRead> => {
  const filePath = path.join(dir, SKILL_FILE_NAME);
  const { size } = await stat(filePath);

  if (size > SKILL_FILE_MAX_BYTES) {
    return {
      ok: false,
      reason: `is larger than ${SKILL_FILE_MAX_BYTES} bytes`,
    };
  }

  const text = await readFile(filePath, "utf-8");
  const parsed = parseSkillFile(text, folderName);

  return parsed.ok ? { file: parsed.skill, ok: true } : parsed;
};

/** Returns true if `dir` is a folder that contains a `SKILL.md` entry, after it follows symbolic links. */
const hasSkillFile = async (dir: string): Promise<boolean> => {
  try {
    await stat(path.join(dir, SKILL_FILE_NAME));

    return true;
  } catch (error) {
    if (isNotFound(error) || isNotFolder(error)) {
      return false;
    }

    throw error;
  }
};

const loadSkillFolder = async (
  root: SkillRoot,
  folderName: string
): Promise<FolderLoad> => {
  const dir = path.join(root.dir, folderName);
  const filePath = path.join(dir, SKILL_FILE_NAME);

  try {
    if (!(await hasSkillFile(dir))) {
      return { kind: "none" };
    }

    const read = await readSkillFile(dir, folderName);

    if (!read.ok) {
      return { kind: "warning", warning: `${filePath} ${read.reason}` };
    }

    return {
      kind: "skill",
      skill: {
        dir,
        file: read.file,
        info: {
          description: read.file.description,
          name: read.file.name,
          origin: root.origin,
          path: filePath,
        },
      },
    };
  } catch (error) {
    return {
      kind: "warning",
      warning: `${filePath} cannot be read: ${messageOf(error)}`,
    };
  }
};

const scanRoot = async (root: SkillRoot): Promise<readonly FolderLoad[]> => {
  let entries: string[] = [];

  try {
    entries = await readdir(root.dir);
  } catch (error) {
    return isNotFound(error)
      ? []
      : [
          {
            kind: "warning",
            warning: `${root.dir} cannot be read: ${messageOf(error)}`,
          },
        ];
  }

  const folderNames = entries
    .filter((entry) => !entry.startsWith("."))
    .toSorted();

  return await Promise.all(
    folderNames.map(
      async (folderName) => await loadSkillFolder(root, folderName)
    )
  );
};

/**
 * Discovers the Skills in `roots`. Each Skill is a folder with a `SKILL.md` file directly inside a root.
 *
 * Ordering and precedence: a later root overrides an earlier root for a Skill with the same name. Callers pass the
 * shared root first and the Agent root second, so an Agent Skill replaces a shared Skill. An invalid Skill does not
 * override a valid one. A missing root is not a problem. A folder without `SKILL.md`, a hidden folder, and a plain file
 * are not Skills and produce no warning. An invalid or unreadable `SKILL.md` produces a warning, and the Skill does not
 * load. Skills named in `disabled` do not load. Warnings follow root order, then folder name order.
 *
 * Errors: rejects with the abort reason if `signal` aborts. Never rejects for one broken Skill.
 */
export const discoverSkills = async (
  roots: readonly SkillRoot[],
  disabled: ReadonlySet<string>,
  signal: AbortSignal
): Promise<Discovery> => {
  signal.throwIfAborted();

  const scans = await Promise.all(
    roots.map(async (root) => await scanRoot(root))
  );

  signal.throwIfAborted();

  const byName = new Map<string, DiscoveredSkill>();
  const warnings: string[] = [];

  for (const load of scans.flat()) {
    if (load.kind === "skill") {
      byName.set(load.skill.info.name, load.skill);
    } else if (load.kind === "warning") {
      warnings.push(load.warning);
    }
  }

  const skills = [...byName.values()]
    .filter((skill) => !disabled.has(skill.info.name))
    .toSorted((a, b) => a.info.name.localeCompare(b.info.name));

  return { skills, warnings };
};
