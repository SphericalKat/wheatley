// Flow 7 of issue #50: the pre-migration `VACUUM INTO` backup, the migration, the `wheatley restore` round trip, and
// the `node:26-trixie-slim` Docker image build.
import { spawn } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, expect, it } from "vitest";

import { CLI_CHAT_ID, startHarness } from "./harness.js";
import type { Harness, RpcSession } from "./harness.js";

const AGENT = "home";
const LEDGER = "wheatley_migrations";
const OCTAL = 8;
const PERMISSION_DIGITS = 3;

const PRE_MIGRATION_FILE =
  /^agent-\d{8}T\d{9}Z-pre-migration(?:-\d+)?\.sqlite$/u;

const PRE_RESTORE_FILE = /^agent-\d{8}T\d{9}Z-pre-restore(?:-\d+)?\.sqlite$/u;
const DOCKER_BUILD_TIMEOUT_MS = 20 * 60_000;
const DOCKER_RUN_TIMEOUT_MS = 2 * 60_000;
const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..", "..");

/** The `approvals` tables. Dropping them and their ledger row gives the schema of a release before the approvals module. */
const APPROVALS_TABLES = [
  "approvals_waiters",
  "approvals_grants",
  "approvals_requests",
] as const;

let harness: Harness;

beforeEach(async () => {
  harness = await startHarness();
});

afterEach(async () => {
  await harness.cleanup();
});

const backupsDir = (): string => path.join(harness.agentDir(AGENT), "backups");

const agentDatabase = (): string =>
  path.join(harness.agentDir(AGENT), "agent.sqlite");

const backupFiles = async (): Promise<string[]> => {
  try {
    const files = await readdir(backupsDir());

    return files.toSorted();
  } catch {
    return [];
  }
};

/** The permission bits of a file as octal digits, for example `600`. */
const permissions = async (target: string): Promise<string> => {
  const { mode } = await stat(target);

  return mode.toString(OCTAL).slice(-PERMISSION_DIGITS);
};

/** Opens an SQLite file, runs `body`, and closes it again. */
const withDatabase = <T>(
  file: string,
  body: (db: DatabaseSync) => T,
  readOnly = false
): T => {
  const db = new DatabaseSync(file, { readOnly });

  try {
    return body(db);
  } finally {
    db.close();
  }
};

const tableNames = (file: string): string[] =>
  withDatabase(
    file,
    (db) =>
      db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name"
        )
        .all()
        .map((row) => String(row.name)),
    true
  );

const ledgerNamespaces = (file: string): string[] =>
  withDatabase(
    file,
    (db) =>
      db
        .prepare(`SELECT DISTINCT namespace FROM ${LEDGER} ORDER BY namespace`)
        .all()
        .map((row) => String(row.namespace)),
    true
  );

/** Turns the stopped Agent's `agent.sqlite` into the schema of an older release that has no approvals module. */
const downgradeToReleaseWithoutApprovals = (): void => {
  withDatabase(agentDatabase(), (db) => {
    for (const table of APPROVALS_TABLES) {
      db.exec(`DROP TABLE ${table}`);
    }

    db.prepare(`DELETE FROM ${LEDGER} WHERE namespace = ?`).run("approvals");
  });
};

const createTrigger = async (
  session: RpcSession,
  name: string
): Promise<void> => {
  await session.request("triggers.create", {
    agent: AGENT,
    trigger: {
      name,
      paused: true,
      prompt: `Prompt of ${name}`,
      schedule: { kind: "cron", schedule: "0 9 * * *", timezone: "UTC" },
      target: { bindingId: "cli", chatId: CLI_CHAT_ID },
    },
  });
};

const triggerNames = async (): Promise<string[]> => {
  const session = await harness.connect();

  try {
    const { triggers } = await session.request("triggers.list", {
      agent: AGENT,
    });

    return triggers.map((trigger) => trigger.name).toSorted();
  } finally {
    await session.close();
  }
};

const agentState = async (): Promise<{
  readonly state: string;
  readonly lastError: string | undefined;
}> => {
  const session = await harness.connect();

  try {
    const health = await session.request("agents.get", { agent: AGENT });

    return { lastError: health.lastError ?? undefined, state: health.state };
  } finally {
    await session.close();
  }
};

it("backs up agent.sqlite before a migration and restores it with wheatley restore while the daemon is stopped", async () => {
  // A new Agent migrates an empty database, so it gets no backup.
  expect(await backupFiles()).toEqual([]);

  const noBackups = await harness.cli(["restore", AGENT]);

  expect(noBackups.code).toBe(2);
  expect(noBackups.stderr).toContain(`Agent ${AGENT} has no backups.`);

  const first = await harness.connect();
  await createTrigger(first, "before-upgrade");
  await first.close();

  // Simulate an upgrade from a release without the approvals module.
  await harness.stop();
  downgradeToReleaseWithoutApprovals();
  expect(tableNames(agentDatabase())).not.toContain("approvals_requests");
  await harness.restart();

  const upgraded = await agentState();

  expect(upgraded.state).toBe("running");

  const [preMigration, ...otherBackups] = await backupFiles();

  expect(otherBackups).toEqual([]);
  expect(preMigration).toMatch(PRE_MIGRATION_FILE);

  const preMigrationPath = path.join(backupsDir(), preMigration ?? "");

  // The backup holds the schema and data from before the migration. The live database is migrated.
  expect(tableNames(preMigrationPath)).not.toContain("approvals_requests");
  expect(ledgerNamespaces(preMigrationPath)).not.toContain("approvals");
  expect(
    withDatabase(
      preMigrationPath,
      (db) =>
        db
          .prepare("SELECT name FROM triggers_definitions")
          .all()
          .map((row) => String(row.name)),
      true
    )
  ).toEqual(["before-upgrade"]);
  expect(await permissions(preMigrationPath)).toBe("600");
  expect(await permissions(backupsDir())).toBe("700");
  expect(await triggerNames()).toEqual(["before-upgrade"]);

  const second = await harness.connect();
  await createTrigger(second, "after-upgrade");
  await second.close();
  expect(await triggerNames()).toEqual(["after-upgrade", "before-upgrade"]);

  const listing = await harness.cli(["restore", AGENT]);

  expect(listing.code).toBe(2);
  expect(listing.stderr).toContain(`Backups of Agent ${AGENT}, newest first:`);
  expect(listing.stderr).toContain(`${preMigration}  (pre-migration, `);

  // The daemon holds agent.sqlite open, so restore refuses and changes nothing.
  const refused = await harness.cli(["restore", AGENT, preMigration ?? ""]);

  expect(refused.code).toBe(1);
  expect(refused.stderr).toContain("The Wheatley daemon is running");
  expect(await backupFiles()).toEqual([preMigration]);

  await harness.stop();

  const restored = await harness.cli(["restore", AGENT, preMigration ?? ""]);

  expect(restored.stderr).toBe("");
  expect(restored.code).toBe(0);
  expect(restored.stdout).toContain(
    `Restored Agent ${AGENT} from ${preMigrationPath}.`
  );

  const afterRestoreCommand = await backupFiles();

  const preRestore = afterRestoreCommand.find((file) =>
    PRE_RESTORE_FILE.test(file)
  );

  expect(preRestore).toBeDefined();
  expect(restored.stdout).toContain(
    `The replaced agent.sqlite is in backup ${preRestore}.`
  );

  // The restored file has the old schema again. The next start migrates it and takes a new pre-migration backup.
  expect(tableNames(agentDatabase())).not.toContain("approvals_requests");
  await harness.restart();

  const remigrated = await agentState();

  expect(remigrated.state).toBe("running");
  expect(await triggerNames()).toEqual(["before-upgrade"]);
  expect(tableNames(agentDatabase())).toContain("approvals_requests");

  const afterRestore = await backupFiles();

  expect(
    afterRestore.filter((file) => PRE_MIGRATION_FILE.test(file))
  ).toHaveLength(2);
  expect(afterRestore.filter((file) => PRE_RESTORE_FILE.test(file))).toEqual([
    preRestore,
  ]);

  // Restore the safety backup to undo the restore.
  await harness.stop();

  const undo = await harness.cli(["restore", AGENT, preRestore ?? ""]);

  expect(undo.code).toBe(0);
  await harness.restart();
  expect(await triggerNames()).toEqual(["after-upgrade", "before-upgrade"]);
});

it("marks the Agent degraded and names the pre-migration backup to restore if a migration fails", async () => {
  const session = await harness.connect();
  await createTrigger(session, "kept");
  await session.close();
  await harness.stop();

  // The approvals migration is pending, but one of its tables exists, so `CREATE TABLE` fails.
  withDatabase(agentDatabase(), (db) => {
    db.prepare(`DELETE FROM ${LEDGER} WHERE namespace = ?`).run("approvals");
  });

  await harness.restart();

  const [backup, ...others] = await backupFiles();

  expect(others).toEqual([]);
  expect(backup).toMatch(PRE_MIGRATION_FILE);

  const health = await agentState();

  expect(health.state).toBe("degraded");
  expect(health.lastError).toContain(
    `wheatley restore ${AGENT} ${backup ?? ""}`
  );

  // The degraded Agent did not run the migration, and its data is still on disk.
  expect(ledgerNamespaces(agentDatabase())).not.toContain("approvals");
  expect(
    withDatabase(
      agentDatabase(),
      (db) =>
        db
          .prepare("SELECT name FROM triggers_definitions")
          .all()
          .map((row) => String(row.name)),
      true
    )
  ).toEqual(["kept"]);
});

/** The outcome of one finished external command. */
interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const text = (chunks: Buffer[]): string =>
  Buffer.concat(chunks).toString("utf-8");

/** Runs a command and resolves with its exit code and output. It never rejects. A spawn error gives code -1. */
const runCommand = async (
  command: string,
  args: readonly string[],
  options: { readonly cwd?: string; readonly timeoutMs: number }
): Promise<CommandResult> => {
  const { promise, resolve } = Promise.withResolvers<CommandResult>();
  const out: Buffer[] = [];
  const err: Buffer[] = [];

  const child = spawn(command, args, {
    cwd: options.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: options.timeoutMs,
  });

  child.stdout.on("data", (chunk: Buffer) => {
    out.push(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    err.push(chunk);
  });
  child.once("error", (error) => {
    resolve({ code: -1, stderr: error.message, stdout: text(out) });
  });
  child.once("close", (code) => {
    resolve({ code: code ?? -1, stderr: text(err), stdout: text(out) });
  });

  return await promise;
};

const DOCKER_INFO_TIMEOUT_MS = 15_000;

/** Set to `1` to skip the Docker image build, for example on a host without Docker. */
const SKIP_DOCKER_ENV = "WHEATLEY_E2E_SKIP_DOCKER";

/** Resolves an empty string if the Docker daemon answers, else the reason that it does not. */
const dockerUnreachableReason = async (): Promise<string> => {
  const info = await runCommand(
    "docker",
    ["info", "--format", "{{.ServerVersion}}"],
    { timeoutMs: DOCKER_INFO_TIMEOUT_MS }
  );

  if (info.code === 0) {
    return "";
  }

  const [firstLine = ""] = info.stderr.trim().split("\n");

  return `the Docker daemon is unreachable (docker info exited with ${info.code}: ${firstLine})`;
};

const dockerRun = async (
  image: string,
  args: readonly string[]
): Promise<CommandResult> =>
  await runCommand("docker", ["run", "--rm", image, ...args], {
    timeoutMs: DOCKER_RUN_TIMEOUT_MS,
  });

const DOCKER_TEST_TIMEOUT_MS =
  DOCKER_BUILD_TIMEOUT_MS + DOCKER_INFO_TIMEOUT_MS + DOCKER_RUN_TIMEOUT_MS * 8;

it(
  "builds the node:26-trixie-slim Docker image, which runs the wheatley CLI as the node user with /data as home",
  async (context) => {
    if (process.env[SKIP_DOCKER_ENV] === "1") {
      context.skip(`Skipped the Docker image build: ${SKIP_DOCKER_ENV}=1`);
    }

    const reason = await dockerUnreachableReason();

    // The E2E gate includes the image build, so a host without Docker fails unless the Operator opts out.
    expect(
      reason,
      `Set ${SKIP_DOCKER_ENV}=1 to skip the Docker image build on this host`
    ).toBe("");

    const image = `wheatley-e2e:${process.pid}-${Date.now()}`;

    try {
      const build = await runCommand(
        "docker",
        ["build", "--file", "docker/Dockerfile", "--tag", image, "."],
        { cwd: REPO_ROOT, timeoutMs: DOCKER_BUILD_TIMEOUT_MS }
      );

      expect(build.code, build.stderr.slice(-4000)).toBe(0);

      const inspect = await runCommand(
        "docker",
        [
          "image",
          "inspect",
          "--format",
          "{{.Config.User}}|{{.Config.WorkingDir}}|{{json .Config.Cmd}}|{{json .Config.Volumes}}{{range .Config.Env}}|{{.}}{{end}}",
          image,
        ],
        { timeoutMs: DOCKER_RUN_TIMEOUT_MS }
      );

      const [user, workingDir, cmd, volumes, ...env] = inspect.stdout
        .trim()
        .split("|");

      expect({ cmd, user, volumes, workingDir }).toEqual({
        cmd: '["wheatley","daemon"]',
        user: "node",
        volumes: '{"/data":{}}',
        workingDir: "/data",
      });
      expect(env).toEqual(
        expect.arrayContaining([
          "NODE_ENV=production",
          "WHEATLEY_HOME=/data",
          "WHEATLEY_DOCKER=1",
        ])
      );

      const os = await dockerRun(image, ["cat", "/etc/os-release"]);

      expect(os.stdout).toContain("VERSION_CODENAME=trixie");

      const node = await dockerRun(image, ["node", "--version"]);

      expect(node.stdout.trim()).toMatch(/^v26\./u);

      const help = await dockerRun(image, ["wheatley", "--help"]);

      expect(help.code).toBe(0);
      expect(help.stdout).toContain("Usage: wheatley <command> [options]");

      // Inside the image, `update` prints the Docker Compose commands instead of an npm update.
      const update = await dockerRun(image, ["wheatley", "update", "--check"]);

      expect(update.stderr).toBe("");
      expect(update.code).toBe(0);
      expect(update.stdout).toContain("This Wheatley runs in Docker.");
      expect(update.stdout).toContain("docker compose pull");

      // `restore` reads the home folder from WHEATLEY_HOME=/data.
      const restore = await dockerRun(image, ["wheatley", "restore", AGENT]);

      expect(restore.code).toBe(2);
      expect(restore.stderr).toContain(`Agent ${AGENT} has no backups.`);

      // The deployed package contains the bundled dashboard.
      const dashboard = await dockerRun(image, [
        "test",
        "-f",
        "/opt/wheatley/dist/dashboard/index.html",
      ]);

      expect(dashboard.code).toBe(0);
    } finally {
      await runCommand("docker", ["image", "rm", "--force", image], {
        timeoutMs: DOCKER_RUN_TIMEOUT_MS,
      });
    }
  },
  DOCKER_TEST_TIMEOUT_MS
);
