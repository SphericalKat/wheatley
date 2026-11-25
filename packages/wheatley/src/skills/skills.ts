import path from "node:path";

import { decode } from "@wheatley/protocol";
import type { AgentConfig, SkillInfo } from "@wheatley/protocol";
import type { JsonSchema, ToolContext, ToolResult } from "@wheatley/sdk";
import { Type } from "typebox";
import type { Static } from "typebox";

import type {
  ProviderInput,
  SkillProvider,
  ToolDescriptor,
} from "../contracts/extension-catalog.js";
import type { AgentModule, RpcHandlerMap } from "../contracts/module.js";
import { canonicalToolName } from "../contracts/tool-names.js";
import type { Migration } from "../db/migrations.js";
import { discloseBundledFile, discloseSkill } from "./disclosure.js";
import type { Disclosure } from "./disclosure.js";
import { discoverSkills } from "./discovery.js";
import type { DiscoveredSkill, SkillRoot } from "./discovery.js";
import { messageOf } from "./fs-errors.js";

/** The canonical name of the Tool that loads Skill instructions (Tiers 2 and 3). */
export const READ_SKILL_TOOL = canonicalToolName(
  { kind: "builtin" },
  "read_skill"
);

const NAME_DESCRIPTION = "The Skill name from the catalog.";

const PATH_DESCRIPTION =
  "Optional. A bundled file of the Skill, relative to its folder, for example references/forms.md.";

/** Validates read_skill input. It matches `readSkillInputSchema`. */
const ReadSkillInputSchema = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    path: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false }
);

type ReadSkillInput = Static<typeof ReadSkillInputSchema>;

/** The read_skill input schema as plain JSON Schema for the model provider. */
const readSkillInputSchema: JsonSchema = {
  additionalProperties: false,
  properties: {
    name: { description: NAME_DESCRIPTION, minLength: 1, type: "string" },
    path: { description: PATH_DESCRIPTION, minLength: 1, type: "string" },
  },
  required: ["name"],
  type: "object",
};

const readSkillDescriptor: ToolDescriptor = {
  defaultAction: "allow",
  description:
    "Loads a Skill from the Skill catalog. Pass name to read the full instructions of the Skill. Pass name and path to read one bundled file of the Skill.",
  inputSchema: readSkillInputSchema,
  name: READ_SKILL_TOOL,
  source: "builtin",
};

/** What the Skills provider needs: a subset of the `ProviderInput` that the Extension Catalog passes. */
export type SkillProviderInput = Pick<
  ProviderInput,
  "agentDir" | "config" | "homeDir" | "log" | "signal"
>;

const errorResult = (text: string): ToolResult => ({
  content: [{ text, type: "text" }],
  isError: true,
});

const textResult = (text: string): ToolResult => ({
  content: [{ text, type: "text" }],
});

const skillRoots = (input: SkillProviderInput): readonly SkillRoot[] => [
  { dir: path.join(input.homeDir, "skills"), origin: "shared" },
  { dir: path.join(input.agentDir, "skills"), origin: "agent" },
];

const disabledSkills = (config: AgentConfig): ReadonlySet<string> =>
  new Set(config.skills?.disabled);

const toolResult = (disclosure: Disclosure): ToolResult =>
  disclosure.ok ? textResult(disclosure.text) : errorResult(disclosure.reason);

/**
 * Creates the Skills provider of one Agent (ADR 0006). It discovers Skills once, when it is created, from
 * `<homeDir>/skills/` (`origin: "shared"`) and `<agentDir>/skills/` (`origin: "agent"`).
 *
 * Invariants:
 * - An Agent Skill overrides a shared Skill with the same name. Skills in `config.skills.disabled` do not load.
 * - An invalid `SKILL.md` does not load and appears in `warnings`.
 * - Progressive disclosure: Tier 1 is `catalogPrompt`. Tier 2 (`read_skill` with `name`) and Tier 3 (`read_skill` with
 *   `name` and `path`) read from disk on each call.
 * - The provider offers only `read_skill`, and only if a Skill loaded. The `allowed-tools` metadata of a Skill changes
 *   no Tool and no Permission Policy action. The Approval Gate checks every Tool call, `read_skill` included.
 *
 * Errors: rejects with the abort reason if `input.signal` aborts during discovery. Never rejects for a broken Skill.
 */
export const createSkillProvider = async (
  input: SkillProviderInput
): Promise<SkillProvider> => {
  const discovery = await discoverSkills(
    skillRoots(input),
    disabledSkills(input.config),
    input.signal
  );

  const byName = new Map<string, DiscoveredSkill>(
    discovery.skills.map((skill) => [skill.info.name, skill])
  );

  const infos: readonly SkillInfo[] = discovery.skills.map(
    (skill) => skill.info
  );

  const catalog = discovery.skills
    .map((skill) => `- ${skill.info.name}: ${skill.info.description}`)
    .join("\n");

  const tools: readonly ToolDescriptor[] =
    byName.size > 0 ? [readSkillDescriptor] : [];

  for (const warning of discovery.warnings) {
    input.log.warn("Skipped a Skill", { warning });
  }

  const readSkill = async (
    parsed: ReadSkillInput,
    ctx: ToolContext
  ): Promise<ToolResult> => {
    const skill = byName.get(parsed.name);

    if (skill === undefined) {
      return errorResult(`Unknown Skill: ${parsed.name}`);
    }

    const disclosure =
      parsed.path === undefined
        ? await discloseSkill(skill)
        : await discloseBundledFile(skill, parsed.path);

    if (ctx.signal.aborted) {
      return errorResult(`${READ_SKILL_TOOL} was aborted`);
    }

    return toolResult(disclosure);
  };

  return {
    catalogPrompt: () => catalog,
    close: async () => {
      await Promise.resolve();
    },
    execute: async (name, toolInput, ctx) => {
      if (name !== READ_SKILL_TOOL || byName.size === 0) {
        return errorResult(`Unknown Tool: ${name}`);
      }

      if (ctx.signal.aborted) {
        return errorResult(`${READ_SKILL_TOOL} was aborted`);
      }

      const decoded = decode(ReadSkillInputSchema, toolInput);

      if (!decoded.ok) {
        const issues = decoded.issues.map(
          (issue) => `${issue.path} ${issue.message}`
        );

        return errorResult(
          `Invalid input for ${READ_SKILL_TOOL}: ${issues.join("; ")}`
        );
      }

      try {
        return await readSkill(decoded.value, ctx);
      } catch (error) {
        return errorResult(messageOf(error));
      }
    },
    health: () => [],
    skills: () => infos,
    tools: () => tools,
    warnings: () => discovery.warnings,
  };
};

/** The SQLite migrations of the Skills module. Skills live on disk, so the module has no tables. */
export const skillsMigrations: readonly Migration[] = [];

/**
 * The JSON-RPC handlers of the Skills module. `extensions.list` reports Skills through
 * `AgentExtensions.skills`, so the module handles no method itself.
 */
export const skillsRpcHandlers: RpcHandlerMap = {};

/** What the Skills module needs besides the Agent module context. */
export interface SkillsModuleDeps {
  /** The Deployment home, `~/.wheatley/` or `/data/` in Docker. Shared Skills live in its `skills/` folder. */
  readonly homeDir: string;
  readonly config: AgentConfig;
}

/**
 * The Skills module for Wave 2 wiring. Its API is the Agent's `SkillProvider`. `create` discovers the Skills, so the
 * module needs no `start`. `stop` closes the provider.
 */
export const skillsModule: AgentModule<SkillsModuleDeps, SkillProvider> = {
  create: async (ctx, deps) => {
    const provider = await createSkillProvider({
      agentDir: ctx.agentDir,
      config: deps.config,
      homeDir: deps.homeDir,
      log: ctx.log,
      signal: new AbortController().signal,
    });

    return { api: provider, rpc: skillsRpcHandlers, stop: provider.close };
  },
  migrations: skillsMigrations,
  name: "skills",
  scope: "agent",
};
