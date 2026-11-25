import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { lstat, mkdir } from "node:fs/promises";
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

/** A file mode is a multiple of this value if its six lowest bits, the group and other permissions, are all zero. */
const GROUP_AND_OTHER_BITS_MODULUS = 0o100;

/** The base of the fallback folder if the systemd user runtime folder does not exist. */
const SHARED_TMP_DIR = "/tmp";

/** The Unix socket of a Deployment home. */
export interface DaemonSocket {
  /** The socket path that the daemon listens on and that every client connects to. */
  readonly path: string;
  /** The owner-only folder that holds `path`, or `undefined` if `path` is in the home. */
  readonly fallbackDir: string | undefined;
}

/** The longest socket path in bytes. `sun_path` also holds the closing NUL byte. */
const maxSocketPathBytes = (): number =>
  (SUN_PATH_BYTES[process.platform] ?? DEFAULT_SUN_PATH_BYTES) - 1;

const fits = (socketPath: string): boolean =>
  Buffer.byteLength(socketPath) <= maxSocketPathBytes();

const isOpenToOthers = (mode: number): boolean =>
  mode % GROUP_AND_OTHER_BITS_MODULUS !== 0;

const isDirectory = (dir: string): boolean => {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
};

/** The home with symlinks resolved. A home that does not exist yet keeps its absolute path. */
const canonicalHome = (home: string): string => {
  const resolved = path.resolve(home);

  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
};

/**
 * The fallback folder comes from the file system, not from environment variables, so a daemon and a client with
 * different `XDG_RUNTIME_DIR` or `TMPDIR` values agree on it.
 */
const fallbackDirOf = (): string => {
  const uid = process.getuid?.();
  const runtimeDir = `/run/user/${uid}`;

  const base =
    uid !== undefined && process.platform === "linux" && isDirectory(runtimeDir)
      ? runtimeDir
      : SHARED_TMP_DIR;

  return path.join(base, `wheatley-${uid ?? "user"}`);
};

/**
 * The Unix socket of the Control Server for a Deployment home. The daemon listens on it, and every client connects to
 * it.
 *
 * Invariants: the path is `<home>/daemon.sock` if that path fits in `sun_path`. Else it is
 * `<base>/wheatley-<uid>/<hash>.sock`. The base is `/run/user/<uid>` on Linux if that folder exists, else `/tmp`. The
 * hash comes from the home with symlinks resolved. The result depends only on the home and the file system, so every
 * spelling of one home gives the same result in every process of the user.
 *
 * Errors: does not throw.
 */
export const daemonSocket = (home: string): DaemonSocket => {
  const canonical = canonicalHome(home);
  const inHome = path.join(canonical, DAEMON_SOCKET_FILE);

  if (fits(inHome)) {
    return { fallbackDir: undefined, path: inHome };
  }

  const fallbackDir = fallbackDirOf();

  const hash = createHash("sha256")
    .update(canonical)
    .digest("hex")
    .slice(0, HOME_HASH_LENGTH);

  return { fallbackDir, path: path.join(fallbackDir, `${hash}.sock`) };
};

/**
 * Creates the owner-only folder `dir` if it is missing, and checks that only the current user can access it.
 *
 * Ordering: call it with `daemonSocket(home).fallbackDir` before the daemon listens on the fallback socket.
 *
 * Errors: rejects if `dir` is not a folder, belongs to another user, or allows access by the group or other users.
 */
export const prepareDaemonSocketDir = async (dir: string): Promise<void> => {
  await mkdir(dir, { mode: PRIVATE_DIR_MODE, recursive: true });

  const info = await lstat(dir);
  const uid = process.getuid?.();
  const ownedByOthers = uid !== undefined && info.uid !== uid;

  if (!info.isDirectory() || ownedByOthers || isOpenToOthers(info.mode)) {
    throw new Error(
      `The socket folder ${dir} must be a folder that only the current user can access`
    );
  }
};
