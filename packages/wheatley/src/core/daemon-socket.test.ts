import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, it } from "vitest";

import { daemonSocket, prepareDaemonSocketDir } from "./daemon-socket.js";

const SOCKET_NAME = /^[0-9a-f]{16}\.sock$/u;
const OWNER_ONLY_DIR_MODE = 0o700;
const GROUP_READABLE_DIR_MODE = 0o750;
const PERMISSION_BITS = 0o777;
const longHome = path.join("/srv", "a".repeat(60), "b".repeat(60), "wh-home");

let scratch = "";

beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "wheatley-socket-"));
});

afterEach(async () => {
  await rm(scratch, { force: true, recursive: true });
});

it("keeps daemon.sock in a home whose path fits in a socket address", () => {
  expect(daemonSocket("/srv/wheatley/")).toEqual({
    fallbackDir: undefined,
    path: "/srv/wheatley/daemon.sock",
  });
});

it("gives a long home the same short socket path for every spelling of the home", () => {
  const socket = daemonSocket(longHome);

  expect(socket.fallbackDir).toBeDefined();
  expect(path.dirname(socket.path)).toBe(socket.fallbackDir);
  expect(path.basename(socket.path)).toMatch(SOCKET_NAME);
  expect(daemonSocket(`${longHome}/../wh-home/`)).toEqual(socket);
  expect(daemonSocket(`${longHome}-2`).path).not.toBe(socket.path);
});

it("gives a long home the same socket path through a symlink to the home", async () => {
  const realHome = path.join(scratch, "r".repeat(60), "s".repeat(60));
  const linkedHome = path.join(scratch, "link");

  await mkdir(realHome, { recursive: true });
  await symlink(realHome, linkedHome);

  expect(daemonSocket(linkedHome)).toEqual(daemonSocket(realHome));
});

it("creates a missing socket folder that only the owner can access", async () => {
  const dir = path.join(scratch, "sockets");

  await prepareDaemonSocketDir(dir);

  const info = await stat(dir);

  expect(info.isDirectory()).toBe(true);
  expect(info.mode % (PERMISSION_BITS + 1)).toBe(OWNER_ONLY_DIR_MODE);
});

it("rejects a socket folder that the group or other users can access", async () => {
  const dir = path.join(scratch, "open");

  await mkdir(dir);
  await chmod(dir, GROUP_READABLE_DIR_MODE);

  await expect(prepareDaemonSocketDir(dir)).rejects.toThrow(
    "only the current user can access"
  );
});

it("rejects a socket folder path that is a file", async () => {
  const file = path.join(scratch, "file");

  await writeFile(file, "");

  await expect(prepareDaemonSocketDir(file)).rejects.toThrow(file);
});

it("rejects a socket folder path that is a symlink to an owner-only folder", async () => {
  const target = path.join(scratch, "target");
  const link = path.join(scratch, "link");

  await mkdir(target, { mode: OWNER_ONLY_DIR_MODE });
  await symlink(target, link);

  await expect(prepareDaemonSocketDir(link)).rejects.toThrow(
    "only the current user can access"
  );
});
