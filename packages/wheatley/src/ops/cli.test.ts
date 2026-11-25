import { mkdir, mkdtemp, rm } from "node:fs/promises";
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
import { readPackageVersion } from "./update.js";

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

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "wheatley-cli-"));
});

afterEach(async () => {
  await rm(home, { force: true, recursive: true });
});

const deps = (overrides: Partial<OpsCliDeps> = {}): OpsCliDeps => ({
  clock,
  env: { WHEATLEY_HOME: home },
  execPath: process.execPath,
  homeDir: home,
  isDaemonRunning: async () => await Promise.resolve(false),
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
    const current = await readPackageVersion();
    const [major = "0", minor = "0", patch = "0"] = current.split(".");
    const sameMajor = `${major}.${minor}.${Number(patch) + 1}`;
    const nextMajor = `${Number(major) + 1}.0.0`;

    const runner = new FakeCommandRunner(() => ({
      stdout: JSON.stringify([current, sameMajor, nextMajor]),
    }));

    const io = captureIo();

    const code = await createOpsCommands(deps({ runner })).update(
      ["--check", "--manager", "npm"],
      io
    );

    expect(code).toBe(0);
    expect(io.stdout[0]).toBe(
      `Update available: ${current} -> ${sameMajor}. Run: wheatley update`
    );
    expect(io.stdout[1]).toContain(
      `npm install --global wheatley@${nextMajor}`
    );
    expect(runner.lines).toStrictEqual(["npm view wheatley versions --json"]);
  });

  it("rejects an unknown package manager", async () => {
    const io = captureIo();

    await expect(
      createOpsCommands(deps()).update(["--manager", "yarn"], io)
    ).resolves.toBe(2);
  });
});
