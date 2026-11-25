import path from "node:path";

import { expect, it } from "vitest";

import { daemonSocketPath } from "./daemon-socket.js";

const MAX_SOCKET_PATH_BYTES = 103;
const RUNTIME_DIR = "/run/user/1000";
const env = { XDG_RUNTIME_DIR: RUNTIME_DIR };
const longHome = path.join("/srv", "a".repeat(60), "b".repeat(60), "wh-home");

it("keeps daemon.sock in a home whose path fits in a socket address", () => {
  expect(daemonSocketPath("/srv/wheatley/", env)).toBe(
    "/srv/wheatley/daemon.sock"
  );
});

it("gives a long home the same short socket path for every spelling of the home", () => {
  const socketPath = daemonSocketPath(longHome, env);

  expect(Buffer.byteLength(socketPath)).toBeLessThanOrEqual(
    MAX_SOCKET_PATH_BYTES
  );
  expect(socketPath.startsWith(`${RUNTIME_DIR}/`)).toBe(true);
  expect(daemonSocketPath(`${longHome}/../wh-home/`, env)).toBe(socketPath);
  expect(daemonSocketPath(`${longHome}-2`, env)).not.toBe(socketPath);
});

it("rejects a long home if the fallback folder is too long as well", () => {
  const runtimeDir = path.join("/run", "x".repeat(120));

  expect(() =>
    daemonSocketPath(longHome, { XDG_RUNTIME_DIR: runtimeDir })
  ).toThrow(/is longer than \d+ bytes/u);
});
