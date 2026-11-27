// Issue #87: the `curl` installer `scripts/install.sh`. The tests run the script against a local fake npm registry and
// a fake Node.js download site, so they stay offline. The CI job `installer` covers the real download path.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..", "..");
const INSTALLER = path.join(REPO_ROOT, "scripts", "install.sh");
const PACKAGE_NAME = "@wheatley-ai/cli";
const LATEST = "0.3.0";
const OLDER = "0.2.0";

/** A release from before `wheatley --version`, like the published 0.2.0. It exits 2 for `--version`. */
const PRE_FLAG = "0.1.0";

/** The Node.js version that the installer pins for its managed runtime. */
const MANAGED_NODE = "26.13.1";
const HOST_NODE = process.execPath;

const HOST_NPM_CLI = path.join(
  path.dirname(HOST_NODE),
  "..",
  "lib",
  "node_modules",
  "npm",
  "bin",
  "npm-cli.js"
);

/** The fake managed runtime exports this variable, so the fake `wheatley` can report which runtime runs it. */
const RUNTIME_MARKER = "FAKE_WHEATLEY_RUNTIME";

interface Result {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface Sandbox {
  readonly root: string;
  readonly home: string;
  readonly registry: string;
  readonly mirror: string;
  readonly server: Server;
}

let sandbox: Sandbox;

const isAddressInfo = (
  address: ReturnType<Server["address"]>
): address is AddressInfo => address !== null && typeof address !== "string";

const run = async (
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv
): Promise<Result> => {
  const { promise, reject, resolve } = Promise.withResolvers<Result>();

  const child = spawn(command, args, {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.once("error", reject);
  child.once("close", (code) => {
    resolve({ code, stderr, stdout });
  });

  return await promise;
};

const tarGz = async (
  cwd: string,
  archive: string,
  entry: string
): Promise<Buffer> => {
  const result = await run(
    "tar",
    ["-czf", archive, "-C", cwd, entry],
    process.env
  );

  if (result.code !== 0) {
    throw new Error(`tar failed: ${result.stderr}`);
  }

  return await readFile(archive);
};

/** Builds the npm tarball of a fake `@wheatley-ai/cli` that prints its version and the runtime marker. */
const packCli = async (work: string, version: string): Promise<Buffer> => {
  const dir = path.join(work, `cli-${version}`);
  const bin = path.join(dir, "package", "bin");

  await mkdir(bin, { recursive: true });
  await writeFile(
    path.join(dir, "package", "package.json"),
    JSON.stringify({
      bin: { wheatley: "bin/wheatley.js" },
      name: PACKAGE_NAME,
      type: "module",
      version,
    })
  );
  await writeFile(
    path.join(bin, "wheatley.js"),
    [
      "#!/usr/bin/env node",
      `if (${JSON.stringify(version === PRE_FLAG)} && process.argv.includes("--version")) {`,
      `  console.error("Unknown option '--version'");`,
      "  process.exit(2);",
      "}",
      `console.log(${JSON.stringify(version)}, process.env.${RUNTIME_MARKER} ?? "host");`,
      "",
    ].join("\n")
  );

  return await tarGz(dir, path.join(work, `cli-${version}.tgz`), "package");
};

const platformName = (): string => {
  const os = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";

  return `${os}-${arch}`;
};

/**
 * Builds a fake Node.js release on the local mirror. Its `node` and `npm` delegate to the host Node.js and set the
 * runtime marker.
 */
const buildMirror = async (mirror: string, work: string): Promise<void> => {
  const name = `node-v${MANAGED_NODE}-${platformName()}`;
  const bin = path.join(work, name, "bin");
  const release = path.join(mirror, `v${MANAGED_NODE}`);

  await mkdir(bin, { recursive: true });
  await mkdir(release, { recursive: true });
  await writeFile(
    path.join(bin, "node"),
    `#!/bin/sh\n${RUNTIME_MARKER}=managed exec "${HOST_NODE}" "$@"\n`
  );
  await writeFile(
    path.join(bin, "npm"),
    `#!/bin/sh\n${RUNTIME_MARKER}=managed exec "${HOST_NODE}" "${HOST_NPM_CLI}" "$@"\n`
  );
  await chmod(path.join(bin, "node"), 0o755);
  await chmod(path.join(bin, "npm"), 0o755);

  const archive = `${name}.tar.gz`;
  const bytes = await tarGz(work, path.join(release, archive), name);
  const digest = createHash("sha256").update(bytes).digest("hex");

  await writeFile(
    path.join(release, "SHASUMS256.txt"),
    `${digest}  ${archive}\n`
  );
};

/** Serves a minimal npm registry with two releases of the fake `@wheatley-ai/cli`. */
const startRegistry = async (
  work: string
): Promise<{ server: Server; url: string }> => {
  const versions = [PRE_FLAG, OLDER, LATEST];

  const packed = await Promise.all(
    versions.map(async (version) => await packCli(work, version))
  );

  const tarballs = new Map(
    versions.map((version, index) => [version, packed[index]])
  );

  const server = createServer();

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();

  if (!isAddressInfo(address)) {
    throw new Error("The fake registry has no TCP address");
  }

  const url = `http://127.0.0.1:${address.port}`;

  const manifest = (version: string) => {
    const bytes = tarballs.get(version) ?? Buffer.alloc(0);

    return {
      bin: { wheatley: "bin/wheatley.js" },
      dist: {
        integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
        shasum: createHash("sha1").update(bytes).digest("hex"),
        tarball: `${url}/cli-${version}.tgz`,
      },
      name: PACKAGE_NAME,
      version,
    };
  };

  server.on("request", (request, response) => {
    const route = decodeURIComponent(request.url ?? "/");
    const tarball = /^\/cli-(?<version>.+)\.tgz$/u.exec(route)?.groups?.version;

    if (tarball !== undefined && tarballs.has(tarball)) {
      response.end(tarballs.get(tarball));

      return;
    }

    if (route === `/${PACKAGE_NAME}/latest`) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(manifest(LATEST)));

      return;
    }

    if (route === `/${PACKAGE_NAME}`) {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          "dist-tags": { latest: LATEST },
          name: PACKAGE_NAME,
          versions: {
            [LATEST]: manifest(LATEST),
            [OLDER]: manifest(OLDER),
            [PRE_FLAG]: manifest(PRE_FLAG),
          },
        })
      );

      return;
    }

    response.statusCode = 404;
    response.end();
  });

  return { server, url };
};

beforeEach(async () => {
  const root = await mkdtemp(path.join(tmpdir(), "wheatley-installer-"));
  const home = path.join(root, "home");
  const mirror = path.join(root, "mirror");
  const work = path.join(root, "work");

  await mkdir(home, { recursive: true });
  await mkdir(work, { recursive: true });
  await buildMirror(mirror, work);
  const { server, url } = await startRegistry(work);

  sandbox = { home, mirror, registry: url, root, server };
});

afterEach(async () => {
  sandbox.server.closeAllConnections();
  sandbox.server.close();
  await once(sandbox.server, "close");
  await rm(sandbox.root, { force: true, recursive: true });
});

/** The environment of a user with an empty home folder, the fake registry, and the fake Node.js mirror. */
const userEnv = (overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  HOME: sandbox.home,
  PATH: process.env.PATH,
  SHELL: "/bin/bash",
  WHEATLEY_NODE_MIRROR: `file://${sandbox.mirror}`,
  npm_config_cache: path.join(sandbox.root, "npm-cache"),
  npm_config_registry: sandbox.registry,
  ...overrides,
});

const install = async (
  args: readonly string[] = [],
  env: NodeJS.ProcessEnv = userEnv()
): Promise<Result> => await run("sh", [INSTALLER, ...args], env);

const shim = (): string => path.join(sandbox.home, ".local", "bin", "wheatley");

const runWheatley = async (
  env: NodeJS.ProcessEnv = userEnv()
): Promise<string> => {
  const result = await run(shim(), ["--version"], env);

  expect(result.code, result.stderr).toBe(0);

  return result.stdout.trim();
};

it("installs the latest release with the host Node.js and writes a working wheatley command", async () => {
  const result = await install();

  expect(result.code, result.stderr).toBe(0);
  expect(await runWheatley()).toBe(`${LATEST} host`);
  await expect(
    access(
      path.join(
        sandbox.home,
        ".local",
        "share",
        "wheatley",
        "app",
        "node_modules",
        "@wheatley-ai",
        "cli"
      )
    )
  ).resolves.toBeUndefined();
  await expect(access(path.join(sandbox.home, ".wheatley"))).rejects.toThrow();
});

it("installs the release that --version names", async () => {
  const result = await install(["--version", OLDER]);

  expect(result.code, result.stderr).toBe(0);
  expect(await runWheatley()).toBe(`${OLDER} host`);
});

it("installs a release that has no --version flag", async () => {
  const result = await install(["--version", PRE_FLAG]);

  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toContain(`Installed wheatley ${PRE_FLAG}`);
  await expect(
    access(path.join(sandbox.home, ".bashrc"))
  ).resolves.toBeUndefined();
});

it("installs the package tarball that WHEATLEY_PACKAGE_SPEC names instead of a registry release", async () => {
  const local = "0.9.0";
  const tarball = path.join(sandbox.root, "local.tgz");

  await writeFile(
    tarball,
    await packCli(path.join(sandbox.root, "work"), local)
  );
  const result = await install([], userEnv({ WHEATLEY_PACKAGE_SPEC: tarball }));

  expect(result.code, result.stderr).toBe(0);
  expect(await runWheatley()).toBe(`${local} host`);
});

it("upgrades in place on a rerun and adds the PATH line to the shell profile once", async () => {
  const first = await install(["--version", OLDER]);

  expect(first.code, first.stderr).toBe(0);
  const rerun = await install();

  expect(rerun.code, rerun.stderr).toBe(0);
  expect(await runWheatley()).toBe(`${LATEST} host`);

  const profile = await readFile(path.join(sandbox.home, ".bashrc"), "utf-8");
  const pathLine = `export PATH="${path.join(sandbox.home, ".local", "bin")}:$PATH"`;

  expect(profile.split("\n").filter((line) => line === pathLine)).toHaveLength(
    1
  );
});

it("leaves shell profiles alone with --no-modify-path", async () => {
  const result = await install(["--no-modify-path"]);

  expect(result.code, result.stderr).toBe(0);
  expect(await runWheatley()).toBe(`${LATEST} host`);
  await expect(access(path.join(sandbox.home, ".bashrc"))).rejects.toThrow();
  await expect(access(path.join(sandbox.home, ".profile"))).rejects.toThrow();
});

it("honors XDG_DATA_HOME and XDG_BIN_HOME", async () => {
  const data = path.join(sandbox.root, "data");
  const bin = path.join(sandbox.root, "bin");
  const env = userEnv({ XDG_BIN_HOME: bin, XDG_DATA_HOME: data });
  const result = await install(["--no-modify-path"], env);

  expect(result.code, result.stderr).toBe(0);
  const version = await run(path.join(bin, "wheatley"), ["--version"], env);

  expect(version.stdout.trim()).toBe(`${LATEST} host`);
  await expect(
    access(
      path.join(data, "wheatley", "app", "node_modules", "@wheatley-ai", "cli")
    )
  ).resolves.toBeUndefined();
});

/** A user environment whose `node` on PATH reports an old version. */
const oldNodeEnv = async (): Promise<NodeJS.ProcessEnv> => {
  const fakeBin = path.join(sandbox.root, "old-node");

  await mkdir(fakeBin, { recursive: true });
  await writeFile(path.join(fakeBin, "node"), "#!/bin/sh\necho v20.0.0\n");
  await chmod(path.join(fakeBin, "node"), 0o755);

  return userEnv({ PATH: `${fakeBin}:${process.env.PATH ?? ""}` });
};

it("downloads the managed Node.js runtime if the host Node.js is too old, and reuses it on a rerun", async () => {
  const env = await oldNodeEnv();
  const first = await install(["--no-modify-path"], env);

  expect(first.code, first.stderr).toBe(0);
  expect(await runWheatley(env)).toBe(`${LATEST} managed`);

  // A rerun must not download again: with the mirror gone, a download fails.
  await rm(sandbox.mirror, { force: true, recursive: true });
  const rerun = await install(["--no-modify-path", "--version", OLDER], env);

  expect(rerun.code, rerun.stderr).toBe(0);
  expect(await runWheatley(env)).toBe(`${OLDER} managed`);
});

it("rejects a Node.js download whose checksum does not match and installs nothing", async () => {
  const env = await oldNodeEnv();
  const sums = path.join(sandbox.mirror, `v${MANAGED_NODE}`, "SHASUMS256.txt");
  const archive = `node-v${MANAGED_NODE}-${platformName()}.tar.gz`;

  await writeFile(sums, `${"0".repeat(64)}  ${archive}\n`);
  const result = await install(["--no-modify-path"], env);

  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("checksum mismatch");
  await expect(access(shim())).rejects.toThrow();
  expect(
    await readdir(
      path.join(sandbox.home, ".local", "share", "wheatley", "runtime")
    )
  ).toStrictEqual([]);
});
