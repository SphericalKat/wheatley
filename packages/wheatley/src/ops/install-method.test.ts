import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, it } from "vitest";

import { FakeCommandRunner } from "./command-runner.fake.js";
import type { CommandScript } from "./command-runner.fake.js";
import { resolveInstallation } from "./install-method.js";
import type { InstallationInput } from "./install-method.js";

let root = "";

beforeEach(async () => {
  root = await realpath(
    await mkdtemp(path.join(tmpdir(), "wheatley-install-"))
  );
});

afterEach(async () => {
  await rm(root, { force: true, recursive: true });
});

/** Creates `<root>/<parts>/` and returns its path. */
const folder = async (...parts: string[]): Promise<string> => {
  const dir = path.join(root, ...parts);
  await mkdir(dir, { recursive: true });

  return dir;
};

const PACKAGE = ["@wheatley-ai", "cli"] as const;

const input = (
  packageDir: string,
  overrides: Partial<InstallationInput> = {}
): InstallationInput => ({
  env: {},
  execPath: process.execPath,
  packageDir,
  platform: "linux",
  runner: new FakeCommandRunner(),
  userHome: path.join(root, "home"),
  ...overrides,
});

/** A runner whose `<manager>` global list contains the package. */
const owns =
  (...managers: string[]): CommandScript =>
  (command) =>
    managers.includes(command)
      ? { stdout: `├── @wheatley-ai/cli@1.0.0` }
      : { exitCode: 1 };

it("detects Docker from WHEATLEY_DOCKER", async () => {
  const dir = await folder("opt", "wheatley");

  await expect(
    resolveInstallation(input(dir, { env: { WHEATLEY_DOCKER: "1" } }))
  ).resolves.toMatchObject({ method: "docker" });
});

it("detects the curl app folder in XDG_DATA_HOME and in ~/.local/share", async () => {
  const xdg = await folder(
    "xdg",
    "wheatley",
    "app",
    "node_modules",
    ...PACKAGE
  );

  const fallback = await folder(
    "home",
    ".local",
    "share",
    "wheatley",
    "app",
    "node_modules",
    ...PACKAGE
  );

  await expect(
    resolveInstallation(
      input(xdg, { env: { XDG_DATA_HOME: path.join(root, "xdg") } })
    )
  ).resolves.toMatchObject({ method: "curl" });
  await expect(resolveInstallation(input(fallback))).resolves.toMatchObject({
    method: "curl",
  });
});

it("resolves symlinks before it reads the path", async () => {
  const keg = await folder(
    "homebrew",
    "Cellar",
    "wheatley",
    "1.0.0",
    "libexec",
    "lib",
    "node_modules",
    ...PACKAGE
  );

  await mkdir(path.join(root, "homebrew", "opt"));
  const link = path.join(root, "homebrew", "opt", "wheatley");
  await symlink(
    path.join(root, "homebrew", "Cellar", "wheatley", "1.0.0"),
    link
  );

  await expect(
    resolveInstallation(
      input(path.join(link, "libexec", "lib", "node_modules", ...PACKAGE))
    )
  ).resolves.toStrictEqual({
    formula: "sphericalkat/tap/wheatley",
    method: "brew",
    packageDir: keg,
  });
});

it("upgrades a Homebrew core formula by its short name", async () => {
  const kegDir = await folder("Cellar", "wheatley", "1.0.0");
  await writeFile(
    path.join(kegDir, "INSTALL_RECEIPT.json"),
    JSON.stringify({ source: { tap: "homebrew/core" } })
  );

  const dir = await folder(
    "Cellar",
    "wheatley",
    "1.0.0",
    "libexec",
    "lib",
    "node_modules",
    ...PACKAGE
  );

  await expect(resolveInstallation(input(dir))).resolves.toMatchObject({
    formula: "wheatley",
    method: "brew",
  });
});

it("detects Volta and mise packages", async () => {
  const volta = await folder(
    "home",
    ".volta",
    "tools",
    "image",
    "packages",
    ...PACKAGE,
    "lib",
    "node_modules",
    ...PACKAGE
  );

  const mise = await folder(
    "home",
    ".local",
    "share",
    "mise",
    "installs",
    "npm-wheatley-ai-cli",
    "1.0.0",
    "lib",
    "node_modules",
    ...PACKAGE
  );

  await expect(resolveInstallation(input(volta))).resolves.toMatchObject({
    method: "volta",
  });
  await expect(resolveInstallation(input(mise))).resolves.toMatchObject({
    method: "mise",
  });
});

it("detects an AUR package that pacman owns in /usr/lib/node_modules", async () => {
  const dir = await folder("usr", "lib", "node_modules", ...PACKAGE);

  const runner = new FakeCommandRunner((command) =>
    command === "pacman" ? { stdout: "wheatley-cli" } : { exitCode: 1 }
  );

  await expect(
    resolveInstallation(input(dir, { runner }))
  ).resolves.toMatchObject({ method: "aur" });
  expect(runner.lines).toContain(`pacman -Qqo ${dir}`);
});

it("treats /usr/lib/node_modules without a pacman owner as npm", async () => {
  const dir = await folder("usr", "lib", "node_modules", ...PACKAGE);

  await expect(
    resolveInstallation(
      input(dir, { runner: new FakeCommandRunner(owns("npm")) })
    )
  ).resolves.toMatchObject({ method: "npm" });
});

it("detects a source checkout outside node_modules", async () => {
  const dir = await folder("src", "wheatley", "packages", "wheatley");
  const runner = new FakeCommandRunner();

  await expect(
    resolveInstallation(input(dir, { runner }))
  ).resolves.toStrictEqual({ method: "source", packageDir: dir });
  expect(runner.commands).toHaveLength(0);
});

it("uses the path hint when several package managers list Wheatley", async () => {
  const dir = await folder(
    "home",
    ".local",
    "share",
    "pnpm",
    "global",
    "5",
    "node_modules",
    ...PACKAGE
  );

  const runner = new FakeCommandRunner(owns("npm", "pnpm"));

  await expect(
    resolveInstallation(input(dir, { runner }))
  ).resolves.toMatchObject({ method: "pnpm" });
  expect(runner.lines.toSorted()).toStrictEqual([
    "bun pm ls -g",
    "npm list -g --depth=0 @wheatley-ai/cli",
    "pnpm list -g --depth=0 @wheatley-ai/cli",
    "yarn global list",
  ]);
});

it("detects yarn and bun from their global folders", async () => {
  const yarn = await folder(
    "home",
    ".config",
    "yarn",
    "global",
    "node_modules",
    ...PACKAGE
  );

  const bun = await folder(
    "home",
    ".bun",
    "install",
    "global",
    "node_modules",
    ...PACKAGE
  );

  await expect(
    resolveInstallation(
      input(yarn, { runner: new FakeCommandRunner(owns("yarn")) })
    )
  ).resolves.toMatchObject({ method: "yarn" });
  await expect(
    resolveInstallation(
      input(bun, { runner: new FakeCommandRunner(owns("bun")) })
    )
  ).resolves.toMatchObject({ method: "bun" });
});

it("trusts the global package list when the path has no hint", async () => {
  const dir = await folder("opt", "tools", "node_modules", ...PACKAGE);

  await expect(
    resolveInstallation(
      input(dir, { runner: new FakeCommandRunner(owns("yarn")) })
    )
  ).resolves.toMatchObject({ method: "yarn" });
});

it("falls back to npm when no package manager can be started", async () => {
  const dir = await folder("opt", "tools", "node_modules", ...PACKAGE);

  const runner: InstallationInput["runner"] = {
    run: async () => await Promise.reject(new Error("spawn npm ENOENT")),
  };

  await expect(
    resolveInstallation(input(dir, { runner }))
  ).resolves.toMatchObject({ method: "npm" });
});

it("runs the npm of the prefix that holds the package", async () => {
  const prefix = await folder(
    "fnm",
    "node-versions",
    "v26.13.1",
    "installation"
  );

  const dir = await folder(
    "fnm",
    "node-versions",
    "v26.13.1",
    "installation",
    "lib",
    "node_modules",
    ...PACKAGE
  );

  await mkdir(path.join(prefix, "bin"));
  await writeFile(path.join(prefix, "bin", "node"), "");
  await writeFile(path.join(prefix, "bin", "npm"), "");

  await expect(
    resolveInstallation(
      input(dir, { runner: new FakeCommandRunner(owns("npm")) })
    )
  ).resolves.toStrictEqual({
    method: "npm",
    npm: [path.join(prefix, "bin", "node"), path.join(prefix, "bin", "npm")],
    packageDir: dir,
    prefix,
  });
});

it("uses npm from PATH with the prefix if the prefix has no npm", async () => {
  const dir = await folder("usr", "local", "lib", "node_modules", ...PACKAGE);

  await expect(
    resolveInstallation(input(dir, { method: "npm" }))
  ).resolves.toStrictEqual({
    method: "npm",
    npm: ["npm"],
    packageDir: dir,
    prefix: path.join(root, "usr", "local"),
  });
});

it("skips the detection for an explicit method", async () => {
  const dir = await folder("src", "wheatley", "packages", "wheatley");
  const runner = new FakeCommandRunner();

  await expect(
    resolveInstallation(input(dir, { method: "bun", runner }))
  ).resolves.toStrictEqual({ method: "bun", packageDir: dir });
  expect(runner.commands).toHaveLength(0);
});
