import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";

import type { Tool, ToolResult } from "@wheatley/sdk";

import { checkInput, integerField, stringField } from "./input.js";
import { resolveToolPath } from "./paths.js";

/** The default command timeout. */
export const SHELL_DEFAULT_TIMEOUT_MS = 120_000;

/** The longest command timeout that a call can ask for. */
export const SHELL_MAX_TIMEOUT_MS = 600_000;

/** The combined stdout and stderr that `shell` keeps. It keeps the tail, where errors usually are. */
export const SHELL_MAX_OUTPUT_CHARS = 50_000;

const text = (value: string, isError = false): ToolResult => ({
  content: [{ text: value, type: "text" }],
  isError,
});

interface ShellOutcome {
  readonly output: string;
  readonly dropped: number;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly aborted: boolean;
}

/** Keeps the last `SHELL_MAX_OUTPUT_CHARS` characters of a stream of chunks. */
class OutputTail {
  #text = "";
  #dropped = 0;

  add(chunk: string): void {
    this.#text += chunk;

    if (this.#text.length > SHELL_MAX_OUTPUT_CHARS) {
      const excess = this.#text.length - SHELL_MAX_OUTPUT_CHARS;
      this.#dropped += excess;
      this.#text = this.#text.slice(excess);
    }
  }

  get text(): string {
    return this.#text;
  }

  get dropped(): number {
    return this.#dropped;
  }
}

const killGroup = (pid: number | undefined): void => {
  if (pid === undefined) {
    return;
  }

  try {
    // A negative PID signals the process group, so child processes of the shell stop too.
    process.kill(-pid, "SIGKILL");
  } catch {
    // The group already exited.
  }
};

const runCommand = async (
  command: string,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal
): Promise<ShellOutcome> => {
  const tail = new OutputTail();

  const child = spawn("/bin/sh", ["-c", command], {
    cwd,
    detached: true,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let timedOut = false;
  let aborted = false;

  const timer = setTimeout(() => {
    timedOut = true;
    killGroup(child.pid);
  }, timeoutMs);

  const onAbort = (): void => {
    aborted = true;
    killGroup(child.pid);
  };

  signal.addEventListener("abort", onAbort, { once: true });
  child.stdout.setEncoding("utf-8");
  child.stderr.setEncoding("utf-8");
  child.stdout.on("data", (chunk: string) => {
    tail.add(chunk);
  });
  child.stderr.on("data", (chunk: string) => {
    tail.add(chunk);
  });

  try {
    // `once` rejects if the child emits `error`, for example when `/bin/sh` cannot start.
    await once(child, "close");
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }

  return {
    aborted,
    dropped: tail.dropped,
    exitCode: child.exitCode,
    output: tail.text,
    signal: child.signalCode,
    timedOut,
  };
};

const describeOutcome = (
  outcome: ShellOutcome,
  timeoutMs: number
): ToolResult => {
  const header =
    outcome.dropped > 0
      ? `[${outcome.dropped} earlier characters dropped]\n`
      : "";

  const body = `${header}${outcome.output}`;

  if (outcome.aborted) {
    return text(`${body}\n[the command was stopped]`, true);
  }

  if (outcome.timedOut) {
    return text(`${body}\n[the command timed out after ${timeoutMs} ms]`, true);
  }

  if (outcome.exitCode !== 0) {
    const status =
      outcome.exitCode === null
        ? `signal ${outcome.signal ?? "unknown"}`
        : `exit code ${outcome.exitCode}`;

    return text(`${body}\n[${status}]`, true);
  }

  return text(body === "" ? "[no output, exit code 0]" : body);
};

/** Runs a command with `/bin/sh -c` in the Agent workspace and returns its combined output. */
export const shellTool: Tool = {
  description:
    "Run a shell command with /bin/sh -c and return its combined stdout and stderr. The working directory is the Agent workspace unless cwd is set. A nonzero exit code is an error result.",
  execute: async (input, ctx) => {
    const checked = checkInput(input, {
      command: "string",
      cwd: "optional-string",
      timeoutMs: "optional-integer",
    });

    if (!checked.ok) {
      return text(checked.message, true);
    }

    const requested =
      integerField(checked.value, "timeoutMs") ?? SHELL_DEFAULT_TIMEOUT_MS;

    const timeoutMs = Math.min(Math.max(requested, 1), SHELL_MAX_TIMEOUT_MS);

    const cwd = resolveToolPath(
      ctx.workspaceDir,
      stringField(checked.value, "cwd") ?? "."
    );

    if (ctx.signal.aborted) {
      return text("The command was stopped before it started", true);
    }

    try {
      await mkdir(cwd, { recursive: true });

      const outcome = await runCommand(
        stringField(checked.value, "command") ?? "",
        cwd,
        timeoutMs,
        ctx.signal
      );

      return describeOutcome(outcome, timeoutMs);
    } catch (error) {
      return text(
        `Cannot run the command: ${error instanceof Error ? error.message : String(error)}`,
        true
      );
    }
  },
  inputSchema: {
    additionalProperties: false,
    properties: {
      command: { description: "The shell command", type: "string" },
      cwd: {
        description: "The working directory, relative to the workspace",
        type: "string",
      },
      timeoutMs: {
        description: `Milliseconds before the command is killed; default ${SHELL_DEFAULT_TIMEOUT_MS}, at most ${SHELL_MAX_TIMEOUT_MS}`,
        minimum: 1,
        type: "integer",
      },
    },
    required: ["command"],
    type: "object",
  },
  name: "shell",
};
