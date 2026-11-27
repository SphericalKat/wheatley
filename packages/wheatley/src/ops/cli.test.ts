import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runCli } from "../cli/main.js";
import type { Clock } from "../contracts/module.js";
import { openAgentDatabase } from "../db/database.js";
import { runMigrations } from "../db/migrations.js";
import { backupAgentDatabase } from "./backup.js";
import type { OpsCliDeps } from "./cli.js";
import { FakeCommandRunner } from "./command-runner.fake.js";
import type { FetchFn } from "./registry.js";

const clock: Clock = { now: () => Date.parse("2026-11-26T09:30:00.000Z") };

let home = "";

/** The default package folder of `deps`: a checkout outside `node_modules`. */
const SOURCE_CHECKOUT = ["src", "wheatley", "packages", "wheatley"] as const;

/** Creates a package folder in `<home>/<parts>` with `package.json` at `version`, and returns its path. */
const installedPackage = async (
  version: string,
  ...parts: string[]
): Promise<string> => {
  const dir = path.join(home, ...parts);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ version }));

  return dir;
};

beforeEach(async () => {
  home = await realpath(await mkdtemp(path.join(tmpdir(), "wheatley-cli-")));
  await installedPackage("1.0.0", ...SOURCE_CHECKOUT);
});

afterEach(async () => {
  await rm(home, { force: true, recursive: true });
});

const deps = (overrides: Partial<OpsCliDeps> = {}): OpsCliDeps => ({
  clock,
  env: { WHEATLEY_HOME: home },
  execPath: process.execPath,
  fetch: async () =>
    await Promise.reject(new Error("The test made a registry request")),
  homeDir: home,
  isDaemonRunning: async () => await Promise.resolve(false),
  packageDir: path.join(home, ...SOURCE_CHECKOUT),
  platform: "linux",
  runner: new FakeCommandRunner(),
  uid: 1000,
  userHome: home,
  ...overrides,
});

/** The output of one `wheatley` run, split into lines without the final line break. */
interface OpsResult {
  readonly code: number;
  readonly stdout: string[];
  readonly stderr: string[];
}

const outputLines = (chunks: readonly string[]): string[] => {
  const text = chunks.join("");

  return text === "" ? [] : text.replace(/\n$/u, "").split("\n");
};

// Standard input without lines: the ops commands read none.
const noInput = async function* noInput(): AsyncGenerator<string> {
  await Promise.resolve();
  yield* [];
};

/** Runs `wheatley --home <home> ...argv` with the test dependencies of `service`, `update`, and `restore`. */
const run = async (
  argv: readonly string[],
  overrides: Partial<OpsCliDeps> = {}
): Promise<OpsResult> => {
  const out: string[] = [];
  const err: string[] = [];

  const code = await runCli(
    ["--home", home, ...argv],
    {
      env: {},
      isTTY: false,
      lines: noInput(),
      shutdown: new AbortController().signal,
      stderr: (text) => {
        err.push(text);
      },
      stdout: (text) => {
        out.push(text);
      },
    },
    { ops: deps(overrides) }
  );

  return { code, stderr: outputLines(err), stdout: outputLines(out) };
};

const seedBackup = async (): Promise<string> => {
  const agentDir = path.join(home, "agents", "home");
  await mkdir(agentDir, { recursive: true });

  const db = openAgentDatabase(path.join(agentDir, "agent.sqlite"));

  try {
    runMigrations(db, []);

    const { backup } = await backupAgentDatabase(db, {
      agentDir,
      clock,
      reason: "pre-migration",
    });

    return backup.file;
  } finally {
    db.close();
  }
};

describe("wheatley restore", () => {
  it("restores a backup by file name", async () => {
    const file = await seedBackup();

    const result = await run(["restore", "home", file]);

    expect(result.code).toBe(0);
    expect(result.stdout[0]).toContain(
      `Restored Agent home from ${path.join(home, "agents", "home", "backups", file)}`
    );
  });

  it("refuses while the daemon runs", async () => {
    const file = await seedBackup();

    const result = await run(["restore", "home", file], {
      isDaemonRunning: async () => await Promise.resolve(true),
    });

    expect(result.code).toBe(1);
    expect(result.stderr.join("\n")).toContain("wheatley service stop");
  });

  it("lists the backups and exits 0 if no backup is named", async () => {
    const file = await seedBackup();

    const result = await run(["restore", "home"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toEqual([
      "Backups of Agent home, newest first:",
      `  ${file}  (pre-migration, 2026-11-26T09:30:00.000Z)`,
    ]);
    expect(result.stderr).toEqual([]);
  });

  it("reports an Agent without backups and exits 0", async () => {
    const result = await run(["restore", "home"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toEqual(["Agent home has no backups."]);
    expect(result.stderr).toEqual([]);
  });

  it("prints the usage and exits 2 without an Agent name", async () => {
    const result = await run(["restore"]);

    expect(result.code).toBe(2);
    expect(result.stdout).toEqual([]);
    expect(result.stderr).toContain("error: missing required argument 'agent'");
    expect(result.stderr).toContain(
      "Usage: wheatley restore [options] <agent> [backup]"
    );
  });

  it("prints the usage and exits 2 for an extra argument", async () => {
    const result = await run(["restore", "home", "a.sqlite", "b"]);

    expect(result.code).toBe(2);
    expect(result.stdout).toEqual([]);
    expect(result.stderr).toContain(
      "Usage: wheatley restore [options] <agent> [backup]"
    );
  });

  it("prints the usage and exits 2 for an unknown option", async () => {
    await seedBackup();

    const result = await run(["restore", "home", "--bogus"]);

    expect(result.code).toBe(2);
    expect(result.stdout).toEqual([]);
    expect(result.stderr).toContain("error: unknown option '--bogus'");
    expect(result.stderr).toContain(
      "Usage: wheatley restore [options] <agent> [backup]"
    );
  });

  it("rejects an Agent name that would leave the agents folder", async () => {
    const result = await run(["restore", "../etc", "x.sqlite"]);

    expect(result.code).toBe(1);
    expect(result.stderr[0]).toContain("Invalid Agent name");
  });
});

describe("wheatley service", () => {
  it("installs the systemd unit for the Wheatley home folder", async () => {
    const runner = new FakeCommandRunner();

    const result = await run(["service", "install"], { runner });

    expect(result.code).toBe(0);
    expect(result.stdout[0]).toContain("wheatley.service");
    expect(runner.lines).toContain("systemctl --user enable wheatley.service");
  });

  it("returns a usage error for an unknown action or a bad flag", async () => {
    const unknown = await run(["service", "launch"]);
    const badFlag = await run(["service", "start", "--now"]);

    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain(
      "error: command-argument value 'launch' is invalid for argument 'action'. Allowed choices are install, start, stop, restart, status."
    );
    expect(badFlag.code).toBe(2);
    expect(badFlag.stderr).toContain("error: unknown option '--now'");
    expect(badFlag.stderr).toContain(
      "Usage: wheatley service [options] <action>"
    );
  });
});

const registry =
  (versions: readonly string[]): FetchFn =>
  async () =>
    await Promise.resolve(
      Response.json({
        versions: Object.fromEntries(versions.map((version) => [version, {}])),
      })
    );

describe("wheatley update", () => {
  it("prints the Docker Compose commands in Docker", async () => {
    const result = await run(["update"], {
      env: { WHEATLEY_DOCKER: "1", WHEATLEY_HOME: home },
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("  docker compose pull");
    expect(result.stdout).toContain("  docker compose up -d");
  });

  it("checks within the major version and only reports a new major version", async () => {
    const packageDir = await installedPackage(
      "1.0.0",
      "lib",
      "node_modules",
      "@wheatley-ai",
      "cli"
    );

    const runner = new FakeCommandRunner();

    const result = await run(["update", "--check", "--method", "npm"], {
      fetch: registry(["1.0.0", "1.0.1", "2.0.0"]),
      packageDir,
      runner,
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toStrictEqual([
      "Update available: 1.0.0 -> 1.0.1. Run: wheatley update",
      `Wheatley 2.0.0 is a new major version. wheatley update stays within the current major version. Read the release notes, then run: npm install --global --prefix ${home} @wheatley-ai/cli@2.0.0`,
    ]);
    expect(runner.commands).toHaveLength(0);
  });

  it("updates a detected bun install and checks the new version", async () => {
    const packageDir = await installedPackage(
      "1.0.0",
      ".bun",
      "install",
      "global",
      "node_modules",
      "@wheatley-ai",
      "cli"
    );

    const runner = new FakeCommandRunner((command, args) => {
      if (command === "bun" && args[0] === "install") {
        writeFileSync(
          path.join(packageDir, "package.json"),
          JSON.stringify({ version: "1.2.0" })
        );
      }

      return command === "bun"
        ? { stdout: "@wheatley-ai/cli@1.0.0" }
        : { exitCode: 1 };
    });

    const result = await run(["update"], {
      fetch: registry(["1.0.0", "1.2.0"]),
      packageDir,
      runner,
    });

    expect(result.stderr).toStrictEqual([]);
    expect(result.code).toBe(0);
    expect(runner.lines).toContain(
      "bun install --global @wheatley-ai/cli@1.2.0"
    );
    expect(result.stdout.at(-1)).toBe(
      "Updated Wheatley to 1.2.0. If the daemon runs as a service, run: wheatley service restart"
    );
  });

  it("fails if the package manager leaves the running copy on the old version", async () => {
    const packageDir = await installedPackage(
      "1.0.0",
      "opt",
      "node_modules",
      "@wheatley-ai",
      "cli"
    );

    const result = await run(["update", "--method", "yarn"], {
      fetch: registry(["1.2.0"]),
      packageDir,
    });

    expect(result.code).toBe(1);
    expect(result.stderr[0]).toContain(
      `${packageDir} still has Wheatley 1.0.0`
    );
  });

  it("prints instructions for a Volta install and changes nothing", async () => {
    const packageDir = await installedPackage(
      "1.0.0",
      ".volta",
      "tools",
      "image",
      "packages",
      "@wheatley-ai",
      "cli",
      "lib",
      "node_modules",
      "@wheatley-ai",
      "cli"
    );

    const runner = new FakeCommandRunner();

    const result = await run(["update"], {
      fetch: registry(["1.0.3"]),
      packageDir,
      runner,
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toStrictEqual([
      "Wheatley 1.0.3 is available. This Wheatley runs 1.0.0.",
      "Volta manages this Wheatley. To update it, run:",
      "  volta install @wheatley-ai/cli@1.0.3",
    ]);
    expect(runner.commands).toHaveLength(0);
  });

  it("refuses a source checkout", async () => {
    const result = await run(["update"]);

    expect(result.code).toBe(1);
    expect(result.stderr[0]).toContain("source checkout");
  });

  it("rejects an unknown method and the removed --manager flag", async () => {
    const method = await run(["update", "--method", "apt"]);
    const manager = await run(["update", "--manager", "npm"]);

    expect(method.code).toBe(2);
    expect(method.stderr).toContain(
      "error: option '--method <method>' argument 'apt' is invalid. Allowed choices are npm, pnpm, yarn, bun, brew, curl."
    );
    expect(manager.code).toBe(2);
    expect(manager.stderr).toContain("error: unknown option '--manager'");
    expect(manager.stderr).toContain("Usage: wheatley update [options]");
  });
});
