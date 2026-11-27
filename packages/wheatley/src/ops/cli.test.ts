import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Clock } from "../contracts/module.js";
import { openAgentDatabase } from "../db/database.js";
import { runMigrations } from "../db/migrations.js";
import { backupAgentDatabase } from "./backup.js";
import { createOpsCommands } from "./cli.js";
import type { CliIo, OpsCliDeps } from "./cli.js";
import { FakeCommandRunner } from "./command-runner.fake.js";
import type { FetchFn } from "./registry.js";

const clock: Clock = { now: () => Date.parse("2026-11-26T09:30:00.000Z") };

interface CapturedIo extends CliIo {
  readonly stdout: string[];
  readonly stderr: string[];
}

const captureIo = (): CapturedIo => {
  const stdout: string[] = [];
  const stderr: string[] = [];

  return {
    err: (line) => {
      stderr.push(line);
    },
    out: (line) => {
      stdout.push(line);
    },
    stderr,
    stdout,
  };
};

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
    const io = captureIo();

    const code = await createOpsCommands(deps()).restore(["home", file], io);

    expect(code).toBe(0);
    expect(io.stdout[0]).toContain(
      `Restored Agent home from ${path.join(home, "agents", "home", "backups", file)}`
    );
  });

  it("refuses while the daemon runs", async () => {
    const file = await seedBackup();
    const io = captureIo();

    const commands = createOpsCommands(
      deps({ isDaemonRunning: async () => await Promise.resolve(true) })
    );

    await expect(commands.restore(["home", file], io)).resolves.toBe(1);
    expect(io.stderr.join("\n")).toContain("wheatley service stop");
  });

  it("lists the backups and exits 0 if no backup is named", async () => {
    const file = await seedBackup();
    const io = captureIo();

    await expect(createOpsCommands(deps()).restore(["home"], io)).resolves.toBe(
      0
    );
    expect(io.stdout).toEqual([
      "Backups of Agent home, newest first:",
      `  ${file}  (pre-migration, 2026-11-26T09:30:00.000Z)`,
    ]);
    expect(io.stderr).toEqual([]);
  });

  it("reports an Agent without backups and exits 0", async () => {
    const io = captureIo();

    await expect(createOpsCommands(deps()).restore(["home"], io)).resolves.toBe(
      0
    );
    expect(io.stdout).toEqual(["Agent home has no backups."]);
    expect(io.stderr).toEqual([]);
  });

  it("prints the usage and exits 2 without an Agent name", async () => {
    const io = captureIo();

    await expect(createOpsCommands(deps()).restore([], io)).resolves.toBe(2);
    expect(io.stdout).toEqual([]);
    expect(io.stderr).toContain("Usage: wheatley restore <agent> [backup]");
  });

  it("prints the usage and exits 2 for an extra argument", async () => {
    const io = captureIo();

    await expect(
      createOpsCommands(deps()).restore(["home", "a.sqlite", "b"], io)
    ).resolves.toBe(2);
    expect(io.stdout).toEqual([]);
    expect(io.stderr).toContain("Usage: wheatley restore <agent> [backup]");
  });

  it("prints the usage and exits 2 for an unknown option", async () => {
    await seedBackup();
    const io = captureIo();

    await expect(
      createOpsCommands(deps()).restore(["home", "--bogus"], io)
    ).resolves.toBe(2);
    expect(io.stdout).toEqual([]);
    expect(io.stderr).toContain("Usage: wheatley restore <agent> [backup]");
  });

  it("rejects an Agent name that would leave the agents folder", async () => {
    const io = captureIo();

    await expect(
      createOpsCommands(deps()).restore(["../etc", "x.sqlite"], io)
    ).resolves.toBe(1);
    expect(io.stderr[0]).toContain("Invalid Agent name");
  });
});

describe("wheatley service", () => {
  it("installs the systemd unit for the Wheatley home folder", async () => {
    const runner = new FakeCommandRunner();
    const io = captureIo();

    const code = await createOpsCommands(deps({ runner })).service(
      ["install"],
      io
    );

    expect(code).toBe(0);
    expect(io.stdout[0]).toContain("wheatley.service");
    expect(runner.lines).toContain("systemctl --user enable wheatley.service");
  });

  it("returns a usage error for an unknown action or a bad flag", async () => {
    const io = captureIo();
    const commands = createOpsCommands(deps());

    await expect(commands.service(["launch"], io)).resolves.toBe(2);
    await expect(commands.service(["start", "--now"], io)).resolves.toBe(2);
    expect(io.stderr).toContain(
      "Usage: wheatley service <install|start|stop|restart|status>"
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
    const io = captureIo();

    const commands = createOpsCommands(
      deps({ env: { WHEATLEY_DOCKER: "1", WHEATLEY_HOME: home } })
    );

    await expect(commands.update([], io)).resolves.toBe(0);
    expect(io.stdout).toContain("  docker compose pull");
    expect(io.stdout).toContain("  docker compose up -d");
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
    const io = captureIo();

    const code = await createOpsCommands(
      deps({
        fetch: registry(["1.0.0", "1.0.1", "2.0.0"]),
        packageDir,
        runner,
      })
    ).update(["--check", "--method", "npm"], io);

    expect(code).toBe(0);
    expect(io.stdout).toStrictEqual([
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

    const io = captureIo();

    const code = await createOpsCommands(
      deps({ fetch: registry(["1.0.0", "1.2.0"]), packageDir, runner })
    ).update([], io);

    expect(io.stderr).toStrictEqual([]);
    expect(code).toBe(0);
    expect(runner.lines).toContain(
      "bun install --global @wheatley-ai/cli@1.2.0"
    );
    expect(io.stdout.at(-1)).toBe(
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

    const io = captureIo();

    const code = await createOpsCommands(
      deps({ fetch: registry(["1.2.0"]), packageDir })
    ).update(["--method", "yarn"], io);

    expect(code).toBe(1);
    expect(io.stderr[0]).toContain(`${packageDir} still has Wheatley 1.0.0`);
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
    const io = captureIo();

    const code = await createOpsCommands(
      deps({ fetch: registry(["1.0.3"]), packageDir, runner })
    ).update([], io);

    expect(code).toBe(0);
    expect(io.stdout).toStrictEqual([
      "Wheatley 1.0.3 is available. This Wheatley runs 1.0.0.",
      "Volta manages this Wheatley. To update it, run:",
      "  volta install @wheatley-ai/cli@1.0.3",
    ]);
    expect(runner.commands).toHaveLength(0);
  });

  it("refuses a source checkout", async () => {
    const io = captureIo();

    await expect(createOpsCommands(deps()).update([], io)).resolves.toBe(1);
    expect(io.stderr[0]).toContain("source checkout");
  });

  it("rejects an unknown method and the removed --manager flag", async () => {
    const io = captureIo();
    const commands = createOpsCommands(deps());

    await expect(commands.update(["--method", "apt"], io)).resolves.toBe(2);
    await expect(commands.update(["--manager", "npm"], io)).resolves.toBe(2);
    expect(io.stderr).toContain(
      "Usage: wheatley update [--check] [--method npm|pnpm|yarn|bun|brew|curl]"
    );
  });
});
