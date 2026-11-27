import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { DeploymentConfig } from "@wheatley-ai/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SeamError } from "../../contracts/errors.js";
import { temporaryDir } from "../test-support.js";
import { FileConfigStore } from "./config-store.js";

const CONFIG = `# Deployment settings
version: 1

provider:
  anthropic:
    options:
      apiKey:
        secret: ANTHROPIC_KEY # the provider key

agents:
  # The household assistant
  home:
    model: anthropic/claude-sonnet-5-5
    permissionPolicy:
      - tool: read_file
        action: allow
`;

let home: Awaited<ReturnType<typeof temporaryDir>>;

const openStore = async (
  env: Readonly<Record<string, string>> = {}
): Promise<FileConfigStore> =>
  await FileConfigStore.open({ env, homeDir: home.dir });

const seamCode = async (
  promise: Promise<unknown>
): Promise<string | undefined> => {
  try {
    await promise;

    return undefined;
  } catch (error) {
    return error instanceof SeamError ? error.code : "other";
  }
};

beforeEach(async () => {
  home = await temporaryDir();
  await writeFile(path.join(home.dir, "config.yaml"), CONFIG);
});

afterEach(async () => {
  await home.remove();
});

describe("FileConfigStore", () => {
  it("saves a structured config as a patch that keeps comments and key order", async () => {
    const store = await openStore();
    const snapshot = await store.read();

    const next: DeploymentConfig = {
      ...snapshot.config,
      agents: {
        ...snapshot.config.agents,
        home: {
          ...snapshot.config.agents.home,
          instructions: "Be brief",
          model: "anthropic/claude-opus-5",
        },
        work: { model: "anthropic/claude-haiku-5-5" },
      },
    };

    const saved = await store.save({ config: next }, snapshot.revision);
    const raw = await readFile(path.join(home.dir, "config.yaml"), "utf-8");

    expect(raw).toContain("# Deployment settings");
    expect(raw).toContain("# the provider key");
    expect(raw).toContain("  # The household assistant\n  home:");
    expect(raw).toContain("    model: anthropic/claude-opus-5");
    expect(raw.indexOf("home:")).toBeLessThan(raw.indexOf("work:"));
    expect(saved.config).toStrictEqual(next);
    expect(saved.revision).not.toBe(snapshot.revision);
    await expect(store.read()).resolves.toStrictEqual(saved);
  });

  it("rejects a stale expectedRevision and writes nothing", async () => {
    const store = await openStore();
    const before = await store.read();

    await writeFile(
      path.join(home.dir, "config.yaml"),
      `${CONFIG}# a hand edit\n`
    );

    await expect(
      seamCode(store.save({ raw: CONFIG }, before.revision))
    ).resolves.toBe("revision_conflict");
    await expect(
      readFile(path.join(home.dir, "config.yaml"), "utf-8")
    ).resolves.toBe(`${CONFIG}# a hand edit\n`);
  });

  it("reports schema and rule issues and writes nothing for an invalid config", async () => {
    const store = await openStore();
    const before = await store.read();
    const invalid = `${CONFIG}    frontends:\n      - id: cli\n        type: telegram\n        config: {}\n`;

    await expect(
      store.validate("version: 2\nagents: {}\n")
    ).resolves.not.toHaveLength(0);
    await expect(store.validate(invalid)).resolves.toStrictEqual([
      {
        message: 'The binding ID "cli" is reserved for the CLI Chat',
        path: "/agents/home/frontends/0/id",
      },
    ]);
    await expect(
      seamCode(store.save({ raw: invalid }, before.revision))
    ).resolves.toBe("config_invalid");
    await expect(
      readFile(path.join(home.dir, "config.yaml"), "utf-8")
    ).resolves.toBe(CONFIG);
  });

  it("prepends a Permission Policy rule once and keeps comments", async () => {
    const store = await openStore();

    const first = await store.prependPermissionRule("home", {
      action: "allow",
      tool: "shell",
    });

    const second = await store.prependPermissionRule("home", {
      action: "allow",
      tool: "shell",
    });

    expect(first.config.agents.home?.permissionPolicy).toStrictEqual([
      { action: "allow", tool: "shell" },
      { action: "allow", tool: "read_file" },
    ]);
    expect(second.revision).toBe(first.revision);
    expect(first.raw).toContain("# The household assistant");
    await expect(
      seamCode(
        store.prependPermissionRule("nobody", {
          action: "allow",
          tool: "shell",
        })
      )
    ).resolves.toBe("agent_not_found");
  });
});

describe("FileSecretStore", () => {
  it("stores secrets in an owner-only file, lists references, and lets the environment win", async () => {
    const store = await openStore({ ANTHROPIC_KEY: "sk-from-environment" });

    await store.read();
    await expect(
      store.secrets.set("TELEGRAM_TOKEN", "123:abc-secret")
    ).resolves.toBe("file");
    await expect(
      store.secrets.set("ANTHROPIC_KEY", "sk-from-file")
    ).resolves.toBe("both");

    const file = path.join(home.dir, "secrets.yaml");
    const info = await stat(file);
    const mode = info.mode % 0o1000;

    expect(mode).toBe(0o600);
    expect(store.secrets.get("ANTHROPIC_KEY")).toBe("sk-from-environment");
    await expect(store.secrets.reveal("TELEGRAM_TOKEN")).resolves.toBe(
      "123:abc-secret"
    );
    await expect(store.secrets.list()).resolves.toStrictEqual([
      {
        name: "ANTHROPIC_KEY",
        references: [{ id: "anthropic", kind: "provider" }],
        source: "both",
      },
      { name: "TELEGRAM_TOKEN", references: [], source: "file" },
    ]);

    await expect(store.secrets.delete("TELEGRAM_TOKEN")).resolves.toBe(true);
    await expect(store.secrets.delete("TELEGRAM_TOKEN")).resolves.toBe(false);
    await expect(
      seamCode(store.secrets.reveal("TELEGRAM_TOKEN"))
    ).resolves.toBe("not_found");
  });

  it("redacts secret values and their JSON-escaped forms, but not short values", async () => {
    const store = await openStore({ ANTHROPIC_KEY: 'sk-"quoted"-key' });

    await store.read();
    await store.secrets.set("SHORT", "abc");

    expect(
      store.secrets.redact(
        'key=sk-"quoted"-key json={"k":"sk-\\"quoted\\"-key"} short=abc'
      )
    ).toBe('key=[redacted] json={"k":"[redacted]"} short=abc');
  });

  it("keeps comments of secrets.yaml and rejects a file that is not a map of strings", async () => {
    const file = path.join(home.dir, "secrets.yaml");

    await writeFile(file, "# my secrets\nOLD: value-1\n");
    const store = await openStore();

    await store.secrets.set("NEW", "value-2");
    await expect(readFile(file, "utf-8")).resolves.toBe(
      "# my secrets\nOLD: value-1\nNEW: value-2\n"
    );

    await writeFile(file, "NESTED:\n  value: 1\n");
    await expect(seamCode(openStore())).resolves.toBe("config_invalid");
  });
});
