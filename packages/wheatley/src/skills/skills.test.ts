import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  AgentConfig,
  DeploymentConfig,
  JsonValue,
  PermissionRule,
} from "@wheatley-ai/protocol";
import type { Logger, ToolContext, ToolResult } from "@wheatley-ai/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { InMemoryApprovalGate } from "../contracts/approval-gate.fake.js";
import type { GatedToolCall } from "../contracts/approval-gate.js";
import { InMemoryConfigStore } from "../contracts/config-store.fake.js";
import { InMemoryDeliveryOutbox } from "../contracts/delivery-outbox.fake.js";
import type { SkillProvider } from "../contracts/extension-catalog.js";
import { InMemorySecretStore } from "../contracts/secret-store.fake.js";
import {
  createSkillProvider,
  READ_SKILL_TOOL,
  skillsModule,
} from "./skills.js";

const silentLog: Logger = {
  debug: () => {},
  error: () => {},
  info: () => {},
  warn: () => {},
};

const baseConfig: AgentConfig = { model: "test/model-1" };

let homeDir = "";
let agentDir = "";

const sharedSkill = (...parts: string[]): string =>
  path.join(homeDir, "skills", ...parts);

const agentSkill = (...parts: string[]): string =>
  path.join(agentDir, "skills", ...parts);

const writeText = async (filePath: string, text: string): Promise<void> => {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text);
};

const skillMd = (
  name: string,
  description: string,
  body = `Instructions for ${name}.`,
  extra = ""
): string =>
  `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n${body}\n`;

const load = async (
  config: AgentConfig = baseConfig,
  signal = new AbortController().signal
): Promise<SkillProvider> =>
  await createSkillProvider({
    agentDir,
    config,
    homeDir,
    log: silentLog,
    signal,
  });

const toolContext = (signal = new AbortController().signal): ToolContext => ({
  agentName: "home",
  chat: null,
  conversationId: "conversation-1",
  log: silentLog,
  runId: "run-1",
  signal,
  toolCallId: "call-1",
  workspaceDir: agentDir,
});

const textOf = (result: ToolResult): string =>
  result.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");

const readSkill = async (
  provider: SkillProvider,
  input: JsonValue,
  signal?: AbortSignal
): Promise<ToolResult> =>
  await provider.execute(READ_SKILL_TOOL, input, toolContext(signal));

/** A Trigger-style Run call, which cannot ask for an Approval. */
const gatedCall = (callKey: string, toolName: string): GatedToolCall => ({
  callKey,
  chat: null,
  conversationId: "conversation-1",
  input: {},
  interactive: false,
  runId: "run-1",
  toolName,
});

beforeEach(async () => {
  homeDir = await mkdtemp(path.join(tmpdir(), "wheatley-skills-"));
  agentDir = path.join(homeDir, "agents", "home");
  await mkdir(agentDir, { recursive: true });
});

afterEach(async () => {
  await rm(homeDir, { force: true, recursive: true });
});

describe("Skill discovery", () => {
  it("lets an Agent Skill override a shared Skill with the same name", async () => {
    await writeText(
      sharedSkill("pdf", "SKILL.md"),
      skillMd("pdf", "Shared PDF")
    );
    await writeText(
      sharedSkill("notes", "SKILL.md"),
      skillMd("notes", "Take notes")
    );
    await writeText(agentSkill("pdf", "SKILL.md"), skillMd("pdf", "Agent PDF"));

    const provider = await load();

    expect(provider.skills()).toStrictEqual([
      {
        description: "Take notes",
        name: "notes",
        origin: "shared",
        path: sharedSkill("notes", "SKILL.md"),
      },
      {
        description: "Agent PDF",
        name: "pdf",
        origin: "agent",
        path: agentSkill("pdf", "SKILL.md"),
      },
    ]);
    expect(textOf(await readSkill(provider, { name: "pdf" }))).toContain(
      "Instructions for pdf."
    );
    expect(provider.warnings()).toStrictEqual([]);
  });

  it("does not load disabled Skills from either folder", async () => {
    await writeText(
      sharedSkill("pdf", "SKILL.md"),
      skillMd("pdf", "Shared PDF")
    );
    await writeText(agentSkill("pdf", "SKILL.md"), skillMd("pdf", "Agent PDF"));
    await writeText(
      agentSkill("notes", "SKILL.md"),
      skillMd("notes", "Take notes")
    );

    const provider = await load({
      ...baseConfig,
      skills: { disabled: ["pdf"] },
    });

    expect(provider.skills().map((skill) => skill.name)).toStrictEqual([
      "notes",
    ]);
    const result = await readSkill(provider, { name: "pdf" });

    expect(result.isError).toBe(true);
  });

  it("offers no Tool and an empty catalog when no Skill folder exists", async () => {
    const provider = await load();

    expect(provider.skills()).toStrictEqual([]);
    expect(provider.tools()).toStrictEqual([]);
    expect(provider.catalogPrompt()).toBe("");
    expect(provider.warnings()).toStrictEqual([]);
    const result = await readSkill(provider, { name: "pdf" });

    expect(result.isError).toBe(true);
  });

  it("rejects with the abort reason when the Agent stops during discovery", async () => {
    await writeText(
      sharedSkill("pdf", "SKILL.md"),
      skillMd("pdf", "Read PDFs")
    );
    const controller = new AbortController();
    controller.abort(new Error("Agent stopped"));

    await expect(load(baseConfig, controller.signal)).rejects.toThrow(
      "Agent stopped"
    );
  });
});

describe("Invalid SKILL.md files", () => {
  it("skips each invalid SKILL.md with a warning and loads the valid Skills", async () => {
    const invalidFiles = {
      "bad-name": skillMd("Bad_Name", "Uppercase name"),
      "bad-tools": skillMd("bad-tools", "Tools", "Body", "allowed-tools: 3\n"),
      "bad-yaml": "---\nname: bad-yaml\ndescription: [unclosed\n---\nBody\n",
      "long-description": skillMd("long-description", "x".repeat(1025)),
      mismatch: skillMd("other-name", "Name differs from the folder"),
      "no-description": "---\nname: no-description\n---\nBody\n",
      "no-frontmatter": "# Just Markdown\n",
      "not-mapping": "---\n- a\n- b\n---\nBody\n",
    };

    await Promise.all(
      Object.entries(invalidFiles).map(async ([folder, text]) => {
        await writeText(sharedSkill(folder, "SKILL.md"), text);
      })
    );

    await writeText(
      sharedSkill("pdf", "SKILL.md"),
      skillMd("pdf", "Read PDFs")
    );
    await writeText(sharedSkill("no-skill-file", "README.md"), "Not a Skill");

    const provider = await load();
    const warnings = provider.warnings();

    expect(provider.skills().map((skill) => skill.name)).toStrictEqual(["pdf"]);
    expect(provider.catalogPrompt()).toBe("- pdf: Read PDFs");
    expect(warnings).toHaveLength(Object.keys(invalidFiles).length);

    for (const folder of Object.keys(invalidFiles)) {
      expect(
        warnings.some((warning) =>
          warning.startsWith(sharedSkill(folder, "SKILL.md"))
        )
      ).toBe(true);
    }

    expect(warnings.join("\n")).not.toContain("no-skill-file");
  });

  it("keeps the shared Skill when the Agent copy with the same name is invalid", async () => {
    await writeText(
      sharedSkill("pdf", "SKILL.md"),
      skillMd("pdf", "Shared PDF")
    );
    await writeText(
      agentSkill("pdf", "SKILL.md"),
      skillMd("other", "Agent PDF")
    );

    const provider = await load();

    expect(provider.skills()).toMatchObject([
      { name: "pdf", origin: "shared" },
    ]);
    expect(provider.warnings()).toStrictEqual([
      `${agentSkill("pdf", "SKILL.md")} has the name "other", which differs from its folder name "pdf"`,
    ]);
  });
});

describe("Progressive disclosure", () => {
  beforeEach(async () => {
    await writeText(
      sharedSkill("pdf", "SKILL.md"),
      skillMd(
        "pdf",
        "Fill and read\n  PDF forms",
        "# PDF\n\nRead references/forms.md before you fill a form."
      )
    );
    await writeText(
      sharedSkill("pdf", "references", "forms.md"),
      "Form field rules"
    );
    await writeText(
      sharedSkill("pdf", "scripts", "fill.py"),
      "print('fill')\n"
    );
    await writeText(sharedSkill("pdf", "assets", "blank.bin"), "a\0b");
    await writeText(path.join(homeDir, "secret.txt"), "outside");
  });

  it("puts only names and one-line descriptions in the Tier 1 catalog", async () => {
    const provider = await load();

    expect(provider.catalogPrompt()).toBe("- pdf: Fill and read PDF forms");
    expect(provider.tools()).toMatchObject([
      { defaultAction: "allow", name: "read_skill", source: "builtin" },
    ]);
  });

  it("returns the full body and the bundled file list in Tier 2", async () => {
    const provider = await load();
    const result = await readSkill(provider, { name: "pdf" });
    const text = textOf(result);

    expect(result.isError).toBeUndefined();
    expect(text).toContain("Read references/forms.md before you fill a form.");
    expect(text).not.toContain("description:");
    expect(text).toContain("- assets/blank.bin");
    expect(text).toContain("- references/forms.md");
    expect(text).toContain("- scripts/fill.py");
    expect(text).not.toContain("- SKILL.md");
  });

  it("reads SKILL.md from disk on each Tier 2 call", async () => {
    const provider = await load();
    await writeText(
      sharedSkill("pdf", "SKILL.md"),
      skillMd("pdf", "Read PDFs", "Updated instructions.")
    );

    expect(textOf(await readSkill(provider, { name: "pdf" }))).toContain(
      "Updated instructions."
    );
  });

  it("returns one bundled text file in Tier 3", async () => {
    const provider = await load();

    await expect(
      readSkill(provider, { name: "pdf", path: "references/forms.md" })
    ).resolves.toStrictEqual({
      content: [{ text: "Form field rules", type: "text" }],
    });
  });

  it("refuses Tier 3 paths outside the Skill folder, folders, missing files, and binary files", async () => {
    await symlink(
      path.join(homeDir, "secret.txt"),
      sharedSkill("pdf", "references", "link.md")
    );
    const provider = await load();

    const refusedPaths = [
      "../../secret.txt",
      path.join(homeDir, "secret.txt"),
      "references/link.md",
      "references",
      ".",
      "references/missing.md",
      "assets/blank.bin",
    ];

    const results = await Promise.all(
      refusedPaths.map(
        async (refusedPath) =>
          await readSkill(provider, { name: "pdf", path: refusedPath })
      )
    );

    for (const result of results) {
      expect(result.isError).toBe(true);
      expect(textOf(result)).not.toContain("outside");
    }
  });

  it("returns error results for invalid input, an unknown Skill or Tool, and an aborted call", async () => {
    const provider = await load();
    const aborted = new AbortController();
    aborted.abort();

    const results = [
      await readSkill(provider, "pdf"),
      await readSkill(provider, { name: "" }),
      await readSkill(provider, { name: "pdf", path: 3 }),
      await readSkill(provider, { name: "pdf", extra: true }),
      await readSkill(provider, { name: "missing" }),
      await readSkill(provider, { name: "pdf" }, aborted.signal),
      await provider.execute("shell", { name: "pdf" }, toolContext()),
    ];

    expect(results.map((result) => result.isError)).toStrictEqual(
      results.map(() => true)
    );
  });
});

const gateFor = (
  provider: SkillProvider,
  policy: PermissionRule[]
): InMemoryApprovalGate => {
  const deploymentConfig: DeploymentConfig = {
    agents: { home: { ...baseConfig, permissionPolicy: policy } },
    version: 1,
  };

  const store = new InMemoryConfigStore(
    deploymentConfig,
    new InMemorySecretStore({})
  );

  return new InMemoryApprovalGate("home", {
    config: store,
    defaultAction: (toolName) =>
      provider.tools().find((tool) => tool.name === toolName)?.defaultAction,
    outbox: new InMemoryDeliveryOutbox("home", {
      deliver: async () => {},
      onDelivered: async () => {},
    }),
    policy,
    secrets: store.secrets,
    timeoutMs: null,
    wake: async () => {},
  });
};

const writeDeploySkill = async (): Promise<void> => {
  await writeText(
    sharedSkill("deploy", "SKILL.md"),
    skillMd(
      "deploy",
      "Deploy the app",
      "Run the deploy.",
      "allowed-tools: shell notes:add\n"
    )
  );
};

describe("Permission Policy over allowed-tools", () => {
  it("offers, runs, and allows no Tool that a loaded Skill lists in allowed-tools", async () => {
    await writeDeploySkill();
    const provider = await load();
    const disclosure = textOf(await readSkill(provider, { name: "deploy" }));
    const shellResult = await provider.execute("shell", {}, toolContext());
    const gate = gateFor(provider, []);

    expect(disclosure).toContain(
      "The Permission Policy decides every Tool call."
    );
    expect(provider.tools().map((tool) => tool.name)).toStrictEqual([
      "read_skill",
    ]);
    expect(shellResult.isError).toBe(true);
    expect(textOf(shellResult)).toBe("Unknown Tool: shell");
    await expect(
      gate.check(gatedCall("c1", "read_skill"))
    ).resolves.toMatchObject({ kind: "allow" });
    await expect(
      gate.check(gatedCall("c2", "notes:add"))
    ).resolves.toMatchObject({ kind: "deny", reason: "non_interactive" });
  });

  it("lets the Permission Policy deny read_skill despite its default allow", async () => {
    await writeDeploySkill();
    const provider = await load();
    const gate = gateFor(provider, [{ action: "deny", tool: "read_skill" }]);

    await expect(
      gate.check(gatedCall("c1", "read_skill"))
    ).resolves.toMatchObject({ kind: "deny", reason: "policy" });
  });
});

describe("skillsModule", () => {
  it("creates the Skills provider of the Agent from the Agent module context", async () => {
    await writeText(
      sharedSkill("pdf", "SKILL.md"),
      skillMd("pdf", "Read PDFs")
    );
    await writeText(
      agentSkill("notes", "SKILL.md"),
      skillMd("notes", "Take notes")
    );
    const db = new DatabaseSync(":memory:");

    try {
      const instance = await skillsModule.create(
        {
          agentDir,
          agentName: "home",
          clock: { now: () => 0 },
          db,
          events: { emit: () => {} },
          log: silentLog,
        },
        { config: baseConfig, homeDir }
      );

      expect(instance.api.catalogPrompt()).toBe(
        "- notes: Take notes\n- pdf: Read PDFs"
      );
      await instance.stop?.();
    } finally {
      db.close();
    }
  });
});
