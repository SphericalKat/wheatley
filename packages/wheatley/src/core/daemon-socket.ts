import { createHash } from "node:crypto";
import { lstat, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** The Unix socket of the Control Server inside the Deployment home. */
export const DAEMON_SOCKET_FILE = "daemon.sock";

/** The size of `sun_path` in `struct sockaddr_un`: 104 bytes on macOS and the BSDs, 108 bytes on Linux. */
const SUN_PATH_BYTES: Readonly<Partial<Record<NodeJS.Platform, number>>> = {
  darwin: 104,
  freebsd: 104,
  linux: 108,
  openbsd: 104,
};

const DEFAULT_SUN_PATH_BYTES = 104;

/** The hex characters of the home hash in a fallback socket name. */
const HOME_HASH_LENGTH = 16;

/** The mode of the folder of a fallback socket: the owner only. */
const PRIVATE_DIR_MODE = 0o700;

/** The group and other permission bits are the six lowest bits of a file mode. */
const OWNER_BITS_DIVISOR = 0o100;

/** The environment variables that choose the fallback folder. */
export type SocketEnv = Readonly<Record<string, string | undefined>>;

/** The longest socket path in bytes. `sun_path` also holds the closing NUL byte. */
const maxSocketPathBytes = (): number =>
  (SUN_PATH_BYTES[process.platform] ?? DEFAULT_SUN_PATH_BYTES) - 1;

const fits = (socketPath: string): boolean =>
  Buffer.byteLength(socketPath) <= maxSocketPathBytes();

const userId = (): string => String(process.getuid?.() ?? "user");

/** The owner-only folder of fallback sockets: in `$XDG_RUNTIME_DIR` if it is an absolute path, else in `os.tmpdir()`. */
const fallbackDir = (env: SocketEnv): string => {
  const runtimeDir = env.XDG_RUNTIME_DIR;

  const base =
    runtimeDir !== undefined && path.isAbsolute(runtimeDir)
      ? runtimeDir
      : tmpdir();

  return path.join(base, `wheatley-${userId()}`);
};

const fallbackPath = (home: string, env: SocketEnv): string => {
  const hash = createHash("sha256")
    .update(home)
    .digest("hex")
    .slice(0, HOME_HASH_LENGTH);

  return path.join(fallbackDir(env), `${hash}.sock`);
};

/**
 * The Unix socket path of the Control Server for a Deployment home. The daemon listens on it, and every client
 * connects to it, so both sides must call this function with the same home and environment.
 *
 * Invariants: the result is `<home>/daemon.sock` if that path fits in `sun_path`. Else it is a short path in an
 * owner-only folder under `$XDG_RUNTIME_DIR` or `os.tmpdir()`, named from a hash of the resolved home. The result for
 * one home and environment is always the same.
 *
 * Errors: throws if neither path fits in `sun_path`.
 */
export const daemonSocketPath = (home: string, env: SocketEnv): string => {
  const resolved = path.resolve(home);
  const inHome = path.join(resolved, DAEMON_SOCKET_FILE);

  if (fits(inHome)) {
    return inHome;
  }

  const fallback = fallbackPath(resolved, env);

  if (fits(fallback)) {
    return fallback;
  }

  throw new Error(
    `The Unix socket path ${inHome} is longer than ${maxSocketPathBytes()} bytes, and the fallback ${fallback} is too. Use a shorter --home, or set XDG_RUNTIME_DIR or TMPDIR to a shorter folder.`
  );
};

/**
 * Makes sure that the folder of a socket path from `daemonSocketPath` can hold the daemon socket. For a fallback path,
 * it creates the owner-only folder if it is missing.
 *
 * Ordering: call it before the daemon listens on the path.
 *
 * Errors: rejects if the fallback folder is not a folder, belongs to another user, or allows access by other users.
 */
export const prepareDaemonSocketDir = async (
  home: string,
  socketPath: string
): Promise<void> => {
  const dir = path.dirname(socketPath);

  if (dir === path.resolve(home)) {
    return;
  }

  await mkdir(dir, { mode: PRIVATE_DIR_MODE, recursive: true });

  const info = await lstat(dir);
  const uid = process.getuid?.();
  const ownedByOthers = uid !== undefined && info.uid !== uid;
  const openToOthers = info.mode % OWNER_BITS_DIVISOR !== 0;

  if (!info.isDirectory() || ownedByOthers || openToOthers) {
    throw new Error(
      `The socket folder ${dir} must be a folder that only the current user can access`
    );
  }
};
