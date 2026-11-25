import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import type { DiscoveredSkill, SkillFileRead } from "./discovery.js";
import { readSkillFile } from "./discovery.js";
import { isNotFound } from "./fs-errors.js";
import { SKILL_FILE_NAME } from "./skill-file.js";

/** The maximum size of a bundled file that Tier 3 returns. */
export const BUNDLED_FILE_MAX_BYTES = 256 * 1024;

/** The maximum number of bundled files that Tier 2 lists. */
export const BUNDLED_FILE_LIST_MAX = 200;

/** The maximum folder depth below the Skill folder that Tier 2 lists. */
const BUNDLED_FILE_MAX_DEPTH = 8;

const NUL_BYTE = 0;
const PARENT_SEGMENT = /^\.\.(?:[/\\]|$)/u;

/** The text of a disclosure, or the reason it failed. The reason is for the model. */
export type Disclosure =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: string };

const failure = (reason: string): Disclosure => ({ ok: false, reason });

interface Listing {
  readonly files: string[];
  truncated: boolean;
}

const walk = async (
  root: string,
  dir: string,
  depth: number,
  listing: Listing
): Promise<void> => {
  const entries = await readdir(dir, { withFileTypes: true });

  const visible = entries
    .filter((entry) => !entry.name.startsWith("."))
    .toSorted((a, b) => (a.name < b.name ? -1 : 1));

  for (const entry of visible) {
    if (listing.files.length >= BUNDLED_FILE_LIST_MAX) {
      listing.truncated = true;

      return;
    }

    const entryPath = path.join(dir, entry.name);

    const relativePath = path
      .relative(root, entryPath)
      .split(path.sep)
      .join("/");

    if (entry.isDirectory() && depth < BUNDLED_FILE_MAX_DEPTH) {
      // oxlint-disable-next-line no-await-in-loop -- The walk stops at BUNDLED_FILE_LIST_MAX files, so it reads folders in order.
      await walk(root, entryPath, depth + 1, listing);
    } else if (
      (entry.isFile() || entry.isSymbolicLink()) &&
      relativePath !== SKILL_FILE_NAME
    ) {
      listing.files.push(relativePath);
    }
  }
};

/** Lists the bundled files of a Skill folder as `/`-separated relative paths, without `SKILL.md` and hidden files. */
const listBundledFiles = async (dir: string): Promise<Listing> => {
  const listing: Listing = { files: [], truncated: false };
  await walk(dir, dir, 0, listing);

  return listing;
};

/**
 * Tier 2: reads the full `SKILL.md` of `skill` from disk again, so an edit since discovery shows. Returns the body, the
 * `allowed-tools` metadata with a note that the Permission Policy decides every Tool call, and the bundled files that
 * Tier 3 can read.
 *
 * Returns `ok: false` if the file is now missing or invalid. Rejects only for unexpected I/O errors.
 */
export const discloseSkill = async (
  skill: DiscoveredSkill
): Promise<Disclosure> => {
  const { name } = skill.info;
  let read: SkillFileRead;

  try {
    read = await readSkillFile(skill.dir, path.basename(skill.dir));
  } catch (error) {
    if (isNotFound(error)) {
      return failure(`The Skill ${name} no longer has a ${SKILL_FILE_NAME}`);
    }

    throw error;
  }

  if (!read.ok) {
    return failure(
      `The ${SKILL_FILE_NAME} of the Skill ${name} ${read.reason}`
    );
  }

  const { files, truncated } = await listBundledFiles(skill.dir);
  const sections = [`# Skill: ${name}`, read.file.body];

  if (read.file.allowedTools.length > 0) {
    sections.push(
      `The allowed-tools metadata of this Skill (${read.file.allowedTools.join(", ")}) grants nothing. The Permission Policy decides every Tool call.`
    );
  }

  if (files.length > 0) {
    const more = truncated
      ? `\n(The list stops after ${BUNDLED_FILE_LIST_MAX} files.)`
      : "";

    sections.push(
      `Bundled files. To read one, call read_skill with name "${name}" and its path:\n${files.map((file) => `- ${file}`).join("\n")}${more}`
    );
  }

  return {
    ok: true,
    text: sections.filter((part) => part !== "").join("\n\n"),
  };
};

/** Returns the reason that `filePath` is not a valid relative path inside a Skill folder, or `undefined`. */
const pathProblem = (filePath: string): string | undefined => {
  const normalized = path.normalize(filePath);

  const isOutside =
    path.isAbsolute(filePath) ||
    filePath.includes("\0") ||
    normalized === "." ||
    PARENT_SEGMENT.test(normalized);

  return isOutside
    ? `The path ${filePath} is not a relative path inside the Skill folder`
    : undefined;
};

const resolveInside = async (
  skillDir: string,
  filePath: string
): Promise<string | undefined> => {
  const realDir = await realpath(skillDir);

  const realTarget = await realpath(
    path.join(skillDir, path.normalize(filePath))
  );

  return realTarget.startsWith(`${realDir}${path.sep}`)
    ? realTarget
    : undefined;
};

/**
 * Tier 3: reads one bundled text file of `skill`. `filePath` is relative to the Skill folder, for example
 * `references/forms.md`.
 *
 * Invariant: the file must resolve inside the Skill folder after it follows symbolic links, so `..` segments and links
 * cannot read other files. Returns `ok: false` for such a path, a missing file, a folder, a file larger than
 * `BUNDLED_FILE_MAX_BYTES`, or a binary file. Rejects only for unexpected I/O errors.
 */
export const discloseBundledFile = async (
  skill: DiscoveredSkill,
  filePath: string
): Promise<Disclosure> => {
  const { name } = skill.info;
  const problem = pathProblem(filePath);

  if (problem !== undefined) {
    return failure(problem);
  }

  let target: string | undefined;

  try {
    target = await resolveInside(skill.dir, filePath);
  } catch (error) {
    if (isNotFound(error)) {
      return failure(`The Skill ${name} has no file ${filePath}`);
    }

    throw error;
  }

  if (target === undefined) {
    return failure(
      `The path ${filePath} leaves the folder of the Skill ${name}`
    );
  }

  const info = await stat(target);

  if (!info.isFile()) {
    return failure(`${filePath} in the Skill ${name} is not a file`);
  }

  if (info.size > BUNDLED_FILE_MAX_BYTES) {
    return failure(
      `${filePath} in the Skill ${name} is larger than ${BUNDLED_FILE_MAX_BYTES} bytes`
    );
  }

  const bytes = await readFile(target);

  if (bytes.includes(NUL_BYTE)) {
    return failure(`${filePath} in the Skill ${name} is a binary file`);
  }

  return { ok: true, text: bytes.toString("utf-8") };
};
