import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";
import { parseDocument } from "yaml";

/** The file that defines a Skill inside its folder. */
export const SKILL_FILE_NAME = "SKILL.md";

/** The maximum length of a Skill name (Agent Skills specification). */
export const SKILL_NAME_MAX_LENGTH = 64;

/** The maximum length of a Skill description (Agent Skills specification). */
export const SKILL_DESCRIPTION_MAX_LENGTH = 1024;

/** A `---` line, the YAML frontmatter, and a closing `---` line at the start of the file. */
const FRONTMATTER =
  /^---[ \t]*\r?\n(?:(?<yaml>[\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/u;

const BYTE_ORDER_MARK = "﻿";
const WHITESPACE_RUN = /\s+/gu;

/**
 * The frontmatter keys that Wheatley reads. Other keys, for example `license` and `metadata`, are allowed and ignored.
 * The name rule is from the Agent Skills specification: lowercase letters, digits, and single hyphens between them.
 */
const FrontmatterSchema = Type.Object({
  "allowed-tools": Type.Optional(
    Type.Union([Type.String(), Type.Array(Type.String()), Type.Null()])
  ),
  description: Type.String({
    maxLength: SKILL_DESCRIPTION_MAX_LENGTH,
    minLength: 1,
  }),
  name: Type.String({
    maxLength: SKILL_NAME_MAX_LENGTH,
    pattern: "^[a-z0-9]+(-[a-z0-9]+)*$",
  }),
});

type Frontmatter = Static<typeof FrontmatterSchema>;

/** The parts of a valid `SKILL.md` file. */
export interface SkillFile {
  readonly name: string;
  /** The description with each whitespace run collapsed to one space, so it fits on one catalog line. */
  readonly description: string;
  /**
   * The `allowed-tools` metadata. It is informational only: the Permission Policy decides every Tool call, and no
   * Skill can grant a Tool.
   */
  readonly allowedTools: readonly string[];
  /** The Markdown after the frontmatter. */
  readonly body: string;
}

/** The result of `parseSkillFile`. */
export type ParsedSkillFile =
  | { readonly ok: true; readonly skill: SkillFile }
  | { readonly ok: false; readonly reason: string };

const invalid = (reason: string): ParsedSkillFile => ({ ok: false, reason });

type DecodedFrontmatter =
  | { readonly ok: true; readonly frontmatter: Frontmatter }
  | { readonly ok: false; readonly reason: string };

const decodeFrontmatter = (source: string): DecodedFrontmatter => {
  const document = parseDocument(source);
  const [yamlError] = document.errors;

  if (yamlError !== undefined) {
    return {
      ok: false,
      reason: `has invalid YAML frontmatter: ${yamlError.message}`,
    };
  }

  const data: unknown = document.toJS() ?? {};

  if (Value.Check(FrontmatterSchema, data)) {
    return { frontmatter: data, ok: true };
  }

  const issues = Value.Errors(FrontmatterSchema, data).map(
    (issue) => `${issue.instancePath || "/"} ${issue.message}`
  );

  return { ok: false, reason: `has invalid frontmatter: ${issues.join("; ")}` };
};

const allowedToolsOf = (frontmatter: Frontmatter): readonly string[] => {
  const value = frontmatter["allowed-tools"] ?? [];

  return Array.isArray(value)
    ? value
    : value.split(WHITESPACE_RUN).filter((tool) => tool !== "");
};

/**
 * Parses the text of a `SKILL.md` file in the folder `folderName`.
 *
 * The file must start with YAML frontmatter between two `---` lines. The frontmatter must have a `name` that matches
 * the folder name and the Agent Skills name rules, and a non-blank `description` of at most 1024 characters.
 * `allowed-tools` is optional: a space-separated string or a list of strings.
 *
 * Returns `ok: false` with a reason that completes the sentence "SKILL.md ...". Never throws.
 */
export const parseSkillFile = (
  text: string,
  folderName: string
): ParsedSkillFile => {
  const content = text.startsWith(BYTE_ORDER_MARK) ? text.slice(1) : text;
  const match = FRONTMATTER.exec(content);

  if (match === null) {
    return invalid("has no YAML frontmatter between --- lines");
  }

  const decoded = decodeFrontmatter(match.groups?.yaml ?? "");

  if (!decoded.ok) {
    return invalid(decoded.reason);
  }

  const { frontmatter } = decoded;

  if (frontmatter.name !== folderName) {
    return invalid(
      `has the name "${frontmatter.name}", which differs from its folder name "${folderName}"`
    );
  }

  const description = frontmatter.description
    .replaceAll(WHITESPACE_RUN, " ")
    .trim();

  if (description === "") {
    return invalid("has a blank description");
  }

  return {
    ok: true,
    skill: {
      allowedTools: allowedToolsOf(frontmatter),
      body: content.slice(match[0].length).trim(),
      description,
      name: frontmatter.name,
    },
  };
};
