import path from "node:path";

import { describe, expect, it } from "vitest";

import { FakeCommandRunner } from "./command-runner.fake.js";
import {
  applyUpdate,
  detectInstallMethod,
  planUpdate,
  readPackageVersion,
  selectUpdate,
} from "./update.js";

const published = (versions: readonly string[]): FakeCommandRunner =>
  new FakeCommandRunner((command, args) =>
    command === "npm" && args[0] === "view"
      ? { stdout: JSON.stringify(versions) }
      : undefined
  );

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

describe("update plan", () => {
  it("installs the newest release of the major version with npm", async () => {
    const runner = published(["1.0.0", "1.5.0", "2.0.0"]);

    const plan = await planUpdate({ current: "1.0.0", method: "npm", runner });

    expect(plan).toStrictEqual({
      command: ["npm", "install", "--global", "@wheatley-ai/cli@1.5.0"],
      current: "1.0.0",
      kind: "update",
      newerMajor: "2.0.0",
      target: "1.5.0",
    });
    expect(runner.lines).toStrictEqual([
      "npm view @wheatley-ai/cli versions --json",
    ]);
  });

  it("installs with pnpm for a pnpm install", async () => {
    const plan = await planUpdate({
      current: "1.0.0",
      method: "pnpm",
      runner: published(["1.0.1"]),
    });

    expect(plan.kind === "update" && plan.command).toStrictEqual([
      "pnpm",
      "add",
      "--global",
      "@wheatley-ai/cli@1.0.1",
    ]);
  });

  it("accepts the single-version string that npm view prints", async () => {
    const runner = new FakeCommandRunner(() => ({ stdout: '"1.0.0"' }));

    await expect(
      planUpdate({ current: "1.0.0", method: "npm", runner })
    ).resolves.toStrictEqual({
      current: "1.0.0",
      kind: "up_to_date",
      newerMajor: undefined,
    });
  });

  it("prints Docker Compose commands without a registry query", async () => {
    const runner = new FakeCommandRunner();

    const plan = await planUpdate({
      current: "1.0.0",
      method: "docker",
      runner,
    });

    expect(plan).toStrictEqual({
      commands: ["docker compose pull", "docker compose up -d"],
      kind: "docker",
    });
    expect(runner.commands).toHaveLength(0);
  });

  it("refuses a source checkout unless a package manager is named", async () => {
    await expect(
      planUpdate({ current: "1.0.0", method: "source", runner: published([]) })
    ).rejects.toThrow("source checkout");
    await expect(
      planUpdate({
        current: "1.0.0",
        manager: "pnpm",
        method: "source",
        runner: published(["1.0.2"]),
      })
    ).resolves.toMatchObject({ kind: "update", target: "1.0.2" });
  });

  it("reports a failed registry query", async () => {
    const runner = new FakeCommandRunner(() => ({
      exitCode: 1,
      stderr: "E404 Not Found",
    }));

    await expect(
      planUpdate({ current: "1.0.0", method: "npm", runner })
    ).rejects.toThrow("E404 Not Found");
  });
});

describe("applyUpdate", () => {
  it("runs the install command with the standard streams attached", async () => {
    const runner = new FakeCommandRunner();

    await applyUpdate(
      {
        command: ["npm", "install", "--global", "@wheatley-ai/cli@1.5.0"],
        current: "1.0.0",
        kind: "update",
        newerMajor: undefined,
        target: "1.5.0",
      },
      runner
    );

    expect(runner.commands).toStrictEqual([
      {
        args: ["install", "--global", "@wheatley-ai/cli@1.5.0"],
        command: "npm",
        inheritStdio: true,
      },
    ]);
  });
});

const dir = (...parts: string[]): string => path.join(path.sep, ...parts);

describe("install method", () => {
  it("detects npm, pnpm, Docker, and a source checkout", () => {
    expect(
      detectInstallMethod({}, dir("usr", "lib", "node_modules", "wheatley"))
    ).toBe("npm");
    expect(
      detectInstallMethod(
        {},
        dir(
          "home",
          "k",
          ".local",
          "share",
          "pnpm",
          "global",
          "5",
          "node_modules",
          "wheatley"
        )
      )
    ).toBe("pnpm");
    expect(
      detectInstallMethod(
        {},
        dir(
          "x",
          "node_modules",
          ".pnpm",
          "wheatley@1.0.0",
          "node_modules",
          "wheatley"
        )
      )
    ).toBe("pnpm");
    expect(
      detectInstallMethod({ WHEATLEY_DOCKER: "1" }, dir("opt", "wheatley"))
    ).toBe("docker");
    expect(
      detectInstallMethod({}, dir("src", "wheatley", "packages", "wheatley"))
    ).toBe("source");
  });

  it("reads the version of this package", async () => {
    await expect(readPackageVersion()).resolves.toMatch(/^\d+\.\d+\.\d+/u);
  });
});
