import { canonicalToolName } from "../contracts/tool-names.js";

/** The canonical name of the Tool that loads Skill instructions (Tiers 2 and 3). */
export const READ_SKILL_TOOL = canonicalToolName(
  { kind: "builtin" },
  "read_skill"
);
