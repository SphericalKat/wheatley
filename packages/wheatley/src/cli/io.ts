import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

/** The terminal of one CLI command. Tests pass scripted input and collect the output. */
export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /** Standard input, one line at a time. Commands share it, so each line goes to exactly one reader. */
  readonly lines: AsyncIterator<string>;
  /** True if standard input is a terminal. `ask` without a terminal denies every `ask` Tool (ADR 0011). */
  readonly isTTY: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Aborts when the process receives `SIGINT` or `SIGTERM`. */
  readonly shutdown: AbortSignal;
}

/** The terminal of the running process. */
export const processIo = (): CliIo => {
  const shutdown = new AbortController();

  const stop = (): void => {
    shutdown.abort(new Error("The process received a stop signal"));
  };

  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  const readline = createInterface({ input: process.stdin, terminal: false });

  return {
    env: process.env,
    isTTY: process.stdin.isTTY,
    lines: readline[Symbol.asyncIterator](),
    shutdown: shutdown.signal,
    stderr: (text) => {
      process.stderr.write(text);
    },
    stdout: (text) => {
      process.stdout.write(text);
    },
  };
};

/** Reads the next line, or resolves `undefined` at the end of input. */
export const nextLine = async (io: CliIo): Promise<string | undefined> => {
  const result = await io.lines.next();

  return result.done === true ? undefined : result.value;
};

/** The Deployment home: `--home`, else `WHEATLEY_HOME`, else `~/.wheatley`. */
export const resolveHome = (
  flag: string | undefined,
  env: CliIo["env"]
): string =>
  path.resolve(flag ?? env.WHEATLEY_HOME ?? path.join(homedir(), ".wheatley"));

const isVersionedPackage = (
  value: unknown
): value is { readonly version: string } =>
  typeof value === "object" &&
  value !== null &&
  "version" in value &&
  typeof value.version === "string";

/** The version of the `wheatley` package, read from its `package.json`. */
export const packageVersion = async (): Promise<string> => {
  // The file is two folders up from both `src/cli/` and `dist/cli/`.
  const text = await readFile(
    new URL("../../package.json", import.meta.url),
    "utf-8"
  );

  const value: unknown = JSON.parse(text);

  return isVersionedPackage(value) ? value.version : "0.0.0";
};
