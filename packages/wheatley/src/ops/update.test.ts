import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { FakeCommandRunner } from "./command-runner.fake.js";
import type { Installation } from "./install-method.js";
import type { FetchFn } from "./registry.js";
import {
  applyUpgrade,
  planUpdate,
  readPackageVersion,
  selectUpdate,
  upgradeAction,
} from "./update.js";

const published =
  (versions: readonly string[]): FetchFn =>
  async () =>
    await Promise.resolve(
      Response.json({
        versions: Object.fromEntries(versions.map((version) => [version, {}])),
      })
    );

const offline: FetchFn = async () =>
  await Promise.reject(new Error("The test made a registry request"));

const at = (installation: Installation): Installation => installation;

const npmInstall = at({
  method: "npm",
  npm: ["npm"],
  packageDir: "/usr/local/lib/node_modules/@wheatley-ai/cli",
  prefix: undefined,
});

describe("major-version guard", () => {
  it("picks the newest release of the current major version", () => {
    expect(
      selectUpdate("1.2.0", ["1.1.0", "1.2.0", "1.10.1", "1.3.0", "2.0.0"])
    ).toStrictEqual({ newerMajor: "2.0.0", target: "1.10.1" });
  });

  it("never selects a new major version", () => {
    expect(selectUpdate("1.4.0", ["1.4.0", "2.0.0", "3.1.0"])).toStrictEqual({
      newerMajor: "3.1.0",
      target: undefined,
    });
  });

  it("ignores prereleases and non-version text", () => {
    expect(
      selectUpdate("1.0.0", ["1.1.0-rc.1", "latest", "1.0.1", "2.0.0-beta.1"])
    ).toStrictEqual({ newerMajor: undefined, target: "1.0.1" });
  });

  it("moves a prerelease to the release of the same version", () => {
    expect(selectUpdate("1.0.0-rc.2", ["1.0.0"]).target).toBe("1.0.0");
  });

  it("rejects an invalid installed version", () => {
    expect(() => selectUpdate("next", ["1.0.0"])).toThrow("semantic version");
  });
});

/** Runs the curl `upgradeAction` with a fake `curl` program first on `PATH`. */
const runCurlAction = async (
  fakeCurl: string
): Promise<{ readonly result: SpawnSyncReturns<string> }> => {
  const bin = await mkdtemp(path.join(tmpdir(), "wheatley-curl-"));

  try {
    await writeFile(path.join(bin, "curl"), fakeCurl, { mode: 0o755 });

    const action = upgradeAction(
      at({ method: "curl", packageDir: "/app" }),
      "1.5.0"
    );

    if (action.kind !== "command") {
      throw new Error("The curl install has no upgrade command");
    }

    const [program, ...args] = action.command;

    return {
      result: spawnSync(program, args, {
        encoding: "utf-8",
        env: { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` },
      }),
    };
  } finally {
    await rm(bin, { force: true, recursive: true });
  }
};

describe("upgrade action", () => {
  const dir = "/x/node_modules/@wheatley-ai/cli";

  it("installs the exact version with each Node.js package manager", () => {
    expect(
      upgradeAction(
        at({
          method: "npm",
          npm: ["/p/bin/node", "/p/bin/npm"],
          packageDir: dir,
          prefix: "/p",
        }),
        "1.5.0"
      )
    ).toStrictEqual({
      command: [
        "/p/bin/node",
        "/p/bin/npm",
        "install",
        "--global",
        "--prefix",
        "/p",
        "@wheatley-ai/cli@1.5.0",
      ],
      kind: "command",
      verify: true,
    });
    expect(
      upgradeAction(at({ method: "pnpm", packageDir: dir }), "1.5.0")
    ).toStrictEqual({
      command: ["pnpm", "add", "--global", "@wheatley-ai/cli@1.5.0"],
      kind: "command",
      verify: false,
    });
    expect(
      upgradeAction(at({ method: "yarn", packageDir: dir }), "1.5.0")
    ).toStrictEqual({
      command: ["yarn", "global", "add", "@wheatley-ai/cli@1.5.0"],
      kind: "command",
      verify: true,
    });
    expect(
      upgradeAction(at({ method: "bun", packageDir: dir }), "1.5.0")
    ).toStrictEqual({
      command: ["bun", "install", "--global", "@wheatley-ai/cli@1.5.0"],
      kind: "command",
      verify: true,
    });
  });

  it("upgrades the Homebrew formula", () => {
    expect(
      upgradeAction(
        at({
          formula: "sphericalkat/tap/wheatley",
          method: "brew",
          packageDir: dir,
        }),
        "1.5.0"
      )
    ).toStrictEqual({
      command: ["brew", "upgrade", "sphericalkat/tap/wheatley"],
      kind: "command",
      verify: false,
    });
  });

  it("passes the version flags to the downloaded curl installer", async () => {
    const { result } = await runCurlAction(
      `#!/bin/sh\necho "$@" >&2\necho 'echo "installer $*"'\n`
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe(
      "-fsSL https://raw.githubusercontent.com/SphericalKat/wheatley/main/scripts/install.sh\n"
    );
    expect(result.stdout).toBe("installer --version 1.5.0 --no-modify-path\n");
  });

  it("fails the curl update if the download fails", async () => {
    const { result } = await runCurlAction("#!/bin/sh\nexit 22\n");

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
  });

  it("prints instructions for installs that another tool owns", () => {
    expect(
      upgradeAction(at({ method: "volta", packageDir: dir }), "1.5.0")
    ).toStrictEqual({
      kind: "notice",
      lines: [
        "Volta manages this Wheatley. To update it, run:",
        "  volta install @wheatley-ai/cli@1.5.0",
      ],
    });
    expect(
      upgradeAction(at({ method: "mise", packageDir: dir }), "1.5.0")
    ).toStrictEqual({
      kind: "notice",
      lines: [
        "mise manages this Wheatley. To update it, run:",
        "  mise use -g npm:@wheatley-ai/cli@1.5.0",
      ],
    });
    expect(
      upgradeAction(at({ method: "aur", packageDir: dir }), "1.5.0")
    ).toStrictEqual({
      kind: "notice",
      lines: [
        "This Wheatley is the AUR package wheatley-cli. Update it with your AUR helper, for example:",
        "  paru -Syu",
        "  yay -Syu",
      ],
    });
  });
});

describe("update plan", () => {
  it("updates to the newest release of the major version", async () => {
    const plan = await planUpdate({
      current: "1.0.0",
      env: {},
      fetch: published(["1.0.0", "1.5.0", "2.0.0"]),
      installation: npmInstall,
    });

    expect(plan).toStrictEqual({
      action: {
        command: ["npm", "install", "--global", "@wheatley-ai/cli@1.5.0"],
        kind: "command",
        verify: true,
      },
      current: "1.0.0",
      kind: "update",
      newerMajor: {
        action: {
          command: ["npm", "install", "--global", "@wheatley-ai/cli@2.0.0"],
          kind: "command",
          verify: true,
        },
        version: "2.0.0",
      },
      target: "1.5.0",
    });
  });

  it("reports an up-to-date install", async () => {
    await expect(
      planUpdate({
        current: "1.0.0",
        env: {},
        fetch: published(["1.0.0"]),
        installation: npmInstall,
      })
    ).resolves.toStrictEqual({
      current: "1.0.0",
      kind: "up_to_date",
      newerMajor: undefined,
    });
  });

  it("prints Docker Compose commands without a registry query", async () => {
    await expect(
      planUpdate({
        current: "1.0.0",
        env: {},
        fetch: offline,
        installation: at({ method: "docker", packageDir: "/app" }),
      })
    ).resolves.toStrictEqual({
      commands: ["docker compose pull", "docker compose up -d"],
      kind: "docker",
    });
  });

  it("refuses a source checkout and names --method", async () => {
    await expect(
      planUpdate({
        current: "1.0.0",
        env: {},
        fetch: offline,
        installation: at({ method: "source", packageDir: "/src/wheatley" }),
      })
    ).rejects.toThrow("--method");
  });
});

const withPackage = async (
  version: string,
  body: (dir: string) => Promise<void>
): Promise<void> => {
  const dir = await mkdtemp(path.join(tmpdir(), "wheatley-update-"));

  try {
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ version })
    );
    await body(dir);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
};

describe("applyUpgrade", () => {
  it("runs the command with the standard streams attached", async () => {
    const runner = new FakeCommandRunner();

    await withPackage("1.5.0", async (packageDir) => {
      await applyUpgrade(
        {
          command: ["npm", "install", "--global", "@wheatley-ai/cli@1.5.0"],
          kind: "command",
          verify: true,
        },
        { packageDir, runner, target: "1.5.0", workDir: packageDir }
      );
    });

    expect(runner.commands).toStrictEqual([
      {
        args: ["install", "--global", "@wheatley-ai/cli@1.5.0"],
        command: "npm",
        inheritStdio: true,
      },
    ]);
  });

  it("fails if the running copy keeps the old version", async () => {
    await withPackage("1.0.0", async (packageDir) => {
      await expect(
        applyUpgrade(
          {
            command: ["yarn", "global", "add", "@wheatley-ai/cli@1.5.0"],
            kind: "command",
            verify: true,
          },
          {
            packageDir,
            runner: new FakeCommandRunner(),
            target: "1.5.0",
            workDir: packageDir,
          }
        )
      ).rejects.toThrow(`${packageDir} still has Wheatley 1.0.0`);
    });
  });

  it("reports a failed command", async () => {
    const runner = new FakeCommandRunner(() => ({
      exitCode: 1,
      stderr: "EACCES",
    }));

    await expect(
      applyUpgrade(
        {
          command: ["brew", "upgrade", "wheatley"],
          kind: "command",
          verify: false,
        },
        { packageDir: "/missing", runner, target: "1.5.0", workDir: "/" }
      )
    ).rejects.toThrow("brew upgrade wheatley exited with code 1: EACCES");
  });

  it("reads the version of this package", async () => {
    await expect(readPackageVersion()).resolves.toMatch(/^\d+\.\d+\.\d+/u);
  });
});
