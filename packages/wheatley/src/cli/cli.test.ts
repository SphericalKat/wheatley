import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type {
  AssistantMessage,
  FauxResponseFactory,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WORKSPACE_DIR } from "../core/agent/agent.js";
import { startDaemon } from "../core/daemon.js";
import type { Daemon } from "../core/daemon.js";
import {
  builtinCatalog,
  createFakeLlm,
  FAKE_PROVIDER,
  temporaryDir,
} from "../core/test-support.js";
import type { FakeLlm } from "../core/test-support.js";
import type { CliIo } from "./io.js";
import { runCli } from "./main.js";

let home: Awaited<ReturnType<typeof temporaryDir>>;
let llm: FakeLlm;
let daemon: Daemon | undefined;

interface ScriptedIo {
  readonly io: CliIo;
  readonly stdout: () => string;
  readonly stderr: () => string;
}

const scriptedIo = (input: readonly string[], isTTY = false): ScriptedIo => {
  const out: string[] = [];
  const err: string[] = [];

  const lines = async function* lines(): AsyncGenerator<string> {
    await Promise.resolve();
    yield* input;
  };

  return {
    io: {
      env: {},
      isTTY,
      lines: lines(),
      shutdown: new AbortController().signal,
      stderr: (text) => {
        err.push(text);
      },
      stdout: (text) => {
        out.push(text);
      },
    },
    stderr: () => err.join(""),
    stdout: () => out.join(""),
  };
};

const workspace = (): string =>
  path.join(home.dir, "agents", "home", WORKSPACE_DIR);

/** The model's two turns: three Tool calls, then an answer that quotes the Tool results it saw. */
const toolTurns = (): (AssistantMessage | FauxResponseFactory)[] => [
  fauxAssistantMessage(
    [
      fauxToolCall("read_file", { path: "notes.txt" }),
      fauxToolCall("write_file", {
        content: "written by the agent",
        path: "out/result.txt",
      }),
      fauxToolCall("shell", { command: "cat out/result.txt | tr a-z A-Z" }),
    ],
    { stopReason: "toolUse" }
  ),
  (context) => {
    const results = context.messages.flatMap((message) =>
      message.role === "toolResult"
        ? message.content.flatMap((block) =>
            block.type === "text" ? [block.text] : []
          )
        : []
    );

    return fauxAssistantMessage(`Results: ${results.join(" | ")}`);
  },
];

const writeConfig = async (dir: string): Promise<void> => {
  await writeFile(
    path.join(dir, "config.yaml"),
    [
      "version: 1",
      "agents:",
      "  home:",
      "    model:",
      `      provider: ${FAKE_PROVIDER}`,
      `      id: ${llm.modelId}`,
      "    permissionPolicy:",
      "      - tool: '*'",
      "        action: allow",
      "",
    ].join("\n")
  );
};

const startTestDaemon = async (homeDir: string): Promise<Daemon> =>
  await startDaemon({
    env: {},
    extensions: builtinCatalog(),
    homeDir,
    models: async () => {
      await Promise.resolve();

      return llm.models;
    },
    port: 0,
    version: "test",
  });

beforeEach(async () => {
  home = await temporaryDir();
  llm = createFakeLlm();
  await writeConfig(home.dir);
  daemon = await startTestDaemon(home.dir);
  await writeFile(path.join(workspace(), "notes.txt"), "remember the milk");
});

afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
  await home.remove();
});

describe("wheatley ask", () => {
  it("completes a Run that runs read_file, write_file, and shell, and prints the reply", async () => {
    llm.faux.setResponses(toolTurns());
    const terminal = scriptedIo([]);

    const code = await runCli(
      ["ask", "--home", home.dir, "--agent", "home", "Use", "your", "tools"],
      terminal.io
    );

    expect(terminal.stderr()).toBe("");
    expect(code).toBe(0);
    expect(terminal.stdout()).toContain(
      "Results: remember the milk | Wrote 20 bytes to"
    );
    expect(terminal.stdout()).toContain("WRITTEN BY THE AGENT");
    await expect(
      readFile(path.join(workspace(), "out", "result.txt"), "utf-8")
    ).resolves.toBe("written by the agent");
  });

  it("reads the prompt from standard input and connects over the TCP URL", async () => {
    llm.faux.setResponses([fauxAssistantMessage("pong")]);
    const terminal = scriptedIo(["ping"]);

    const code = await runCli(
      ["ask", "--url", daemon?.server.url ?? "", "--home", home.dir],
      terminal.io
    );

    expect(code).toBe(0);
    expect(terminal.stdout()).toBe("pong\n");
  });

  it("exits 1 and reports the error when the Run fails", async () => {
    llm.faux.setResponses([
      fauxAssistantMessage("", {
        errorMessage: "provider down",
        stopReason: "error",
      }),
    ]);
    const terminal = scriptedIo([]);

    const code = await runCli(
      ["ask", "--home", home.dir, "hello"],
      terminal.io
    );

    expect(code).toBe(1);
    expect(terminal.stderr()).toContain("The Run ended failed");
  });
});

describe("wheatley chat", () => {
  it("completes a Run with read_file, write_file, and shell in the CLI Chat and runs built-in commands", async () => {
    llm.faux.setResponses(toolTurns());

    const terminal = scriptedIo([
      "Use your tools",
      "/status",
      "/model unknown-model",
    ]);

    const code = await runCli(
      ["chat", "--home", home.dir, "--agent", "home"],
      terminal.io
    );

    const output = terminal.stdout();

    expect(code).toBe(0);
    expect(output).toContain("  [read_file]");
    expect(output).toContain("  [write_file]");
    expect(output).toContain("  [shell]");
    expect(output).toContain(
      "home> Results: remember the milk | Wrote 20 bytes to"
    );
    expect(output).toContain("WRITTEN BY THE AGENT");
    expect(output).toContain("home> Agent: home");
    expect(output).toContain(
      `home> Unknown model: ${FAKE_PROVIDER}/unknown-model`
    );
    await expect(
      stat(path.join(workspace(), "out", "result.txt"))
    ).resolves.toMatchObject({});
  });

  it("prints one Agent reply for each command that cannot run", async () => {
    const terminal = scriptedIo(["/model unknown-model", "/goal", "/stop"]);

    const code = await runCli(
      ["chat", "--home", home.dir, "--agent", "home"],
      terminal.io
    );

    expect(code).toBe(0);
    // The first line is the banner. Every line after it must be an Agent reply.
    expect(terminal.stdout().split("\n").slice(1)).toEqual([
      `home> Unknown model: ${FAKE_PROVIDER}/unknown-model`,
      "home> Usage: /goal <objective>",
      "home> No Run is active.",
      "",
    ]);
  });

  it("starts a new Conversation for /new, so the history starts empty", async () => {
    llm.faux.setResponses([fauxAssistantMessage("first answer")]);
    await runCli(["chat", "--home", home.dir], scriptedIo(["hello"]).io);

    const before = await daemon?.deployment
      .agent("home")
      .history({ bindingId: "cli", chatId: "default" }, undefined, 10);

    await runCli(["chat", "--home", home.dir], scriptedIo(["/new"]).io);

    const after = await daemon?.deployment
      .agent("home")
      .history({ bindingId: "cli", chatId: "default" }, undefined, 10);

    expect(before?.messages.map((message) => message.text)).toStrictEqual([
      "hello",
      "first answer",
    ]);
    expect(after?.conversationId).not.toBe(before?.conversationId);
    expect(after?.messages.map((message) => message.text)).toStrictEqual([
      "Started a new Conversation.",
    ]);
  });
});

describe("wheatley status and init", () => {
  it("prints the health of every Agent", async () => {
    const terminal = scriptedIo([]);

    const code = await runCli(["status", "--home", home.dir], terminal.io);

    expect(code).toBe(0);
    expect(terminal.stdout()).toContain("  home: running (0 active Runs)");
  });

  it("explains how to start the daemon when none listens", async () => {
    const terminal = scriptedIo([]);

    const code = await runCli(
      ["status", "--home", path.join(home.dir, "elsewhere")],
      terminal.io
    );

    expect(code).toBe(1);
    expect(terminal.stderr()).toContain('Start it with "wheatley daemon"');
  });

  it("reaches a daemon over the Unix socket of a home whose path is too long for a socket, also after a restart", async () => {
    const deepHome = path.join(home.dir, "n".repeat(60), "m".repeat(60));

    await mkdir(deepHome, { recursive: true });
    await writeConfig(deepHome);

    for (let start = 0; start < 2; start += 1) {
      // oxlint-disable-next-line no-await-in-loop -- The second start must reuse the socket path of the first.
      const deepDaemon = await startTestDaemon(deepHome);
      const terminal = scriptedIo([]);

      try {
        // oxlint-disable-next-line no-await-in-loop -- Each start runs on its own.
        await expect(
          runCli(["status", "--home", deepHome], terminal.io)
        ).resolves.toBe(0);
      } finally {
        // oxlint-disable-next-line no-await-in-loop -- Each start runs on its own.
        await deepDaemon.close();
      }

      expect(terminal.stdout()).toContain("  home: running (0 active Runs)");
    }
  });

  it("creates a valid config.yaml and an owner-only secrets.yaml, and refuses to overwrite them", async () => {
    const target = path.join(home.dir, "fresh");
    const first = scriptedIo([]);

    await expect(
      runCli(["init", "--home", target, "--agent", "helper"], first.io)
    ).resolves.toBe(0);

    const config = await readFile(path.join(target, "config.yaml"), "utf-8");
    const secrets = await stat(path.join(target, "secrets.yaml"));

    expect(config).toContain("  helper:\n");
    expect(secrets.mode % 0o1000).toBe(0o600);

    const second = scriptedIo([]);

    await expect(runCli(["init", "--home", target], second.io)).resolves.toBe(
      1
    );
    expect(second.stderr()).toContain("already exists");
  });

  it("prints the usage on stdout and exits 0 for --help", async () => {
    const terminal = scriptedIo([]);

    await expect(runCli(["--help"], terminal.io)).resolves.toBe(0);
    expect(terminal.stdout()).toContain("Usage: wheatley <command> [options]");
    expect(terminal.stderr()).toBe("");
  });

  it("prints the package version on stdout and exits 0 for --version", async () => {
    const manifest: unknown = JSON.parse(
      await readFile(new URL("../../package.json", import.meta.url), "utf-8")
    );

    const terminal = scriptedIo([]);

    await expect(runCli(["--version"], terminal.io)).resolves.toBe(0);
    expect(manifest).toMatchObject({ version: terminal.stdout().trim() });
    expect(terminal.stdout()).toMatch(/^\S+\n$/u);
    expect(terminal.stderr()).toBe("");
  });

  it("reads --home before or after a core command", async () => {
    for (const argv of [
      ["--home", home.dir, "status"],
      [`--home=${home.dir}`, "status"],
      ["status", "--home", home.dir],
      ["status", `--home=${home.dir}`],
    ]) {
      const terminal = scriptedIo([]);

      // oxlint-disable-next-line no-await-in-loop -- Each spelling of --home runs on its own.
      await expect(runCli(argv, terminal.io)).resolves.toBe(0);
      expect(terminal.stdout()).toContain("  home: running (0 active Runs)");
    }
  });

  it("shows where config.yaml is invalid when the daemon cannot start", async () => {
    const broken = await temporaryDir();
    const file = path.join(broken.dir, "config.yaml");
    const terminal = scriptedIo([]);

    try {
      await writeFile(file, "version: 1\nagents:\n  home:\n    model: 5\n");

      await expect(
        runCli(["daemon", "--home", broken.dir, "--port", "0"], terminal.io)
      ).resolves.toBe(1);
    } finally {
      await broken.remove();
    }

    expect(terminal.stderr()).toBe(
      [
        "error: invalid value at /agents/home/model",
        `  --> ${file}:4:5`,
        "  3 |   home:",
        "> 4 |     model: 5",
        "    |     ^^^^^^^^ must be object",
        "",
        "Cannot start the daemon: config.yaml is invalid",
        "",
      ].join("\n")
    );
  });

  it("rejects an option of another command with exit code 2", async () => {
    for (const [argv, option] of [
      [["status", "--home", home.dir, "--provider", "x"], "--provider"],
      [["init", "--home", home.dir, "--port", "1"], "--port"],
      [["ask", "--home", home.dir, "--model", "m", "hi"], "--model"],
      [["chat", "--home", home.dir, "--host", "h"], "--host"],
      [["daemon", "--home", home.dir, "--agent", "home"], "--agent"],
      [["update", "--home", home.dir, "--url", "ws://x"], "--url"],
      [["restore", "home", "--home", home.dir, "--check"], "--check"],
    ] as const) {
      const terminal = scriptedIo([]);

      // oxlint-disable-next-line no-await-in-loop -- Each command runs on its own.
      await expect(runCli(argv, terminal.io)).resolves.toBe(2);
      expect(terminal.stderr()).toContain(`error: unknown option '${option}'`);
      expect(terminal.stdout()).toBe("");
    }
  });

  it("prints the help of each command on stdout and exits 0", async () => {
    for (const [command, option] of [
      ["init", "--provider <name>"],
      ["daemon", "--port <port>"],
      ["chat", "--agent <name>"],
      ["ask", "--url <ws-url>"],
      ["status", "--url <ws-url>"],
      ["service", "<action>"],
      ["update", "--method <method>"],
      ["restore", "<agent> [backup]"],
    ] as const) {
      const terminal = scriptedIo([]);

      // oxlint-disable-next-line no-await-in-loop -- Each command runs on its own.
      await expect(runCli([command, "--help"], terminal.io)).resolves.toBe(0);
      expect(terminal.stdout()).toContain(`Usage: wheatley ${command}`);
      expect(terminal.stdout()).toContain(option);
      expect(terminal.stdout()).toContain("--home <dir>");
      expect(terminal.stderr()).toBe("");
    }
  });

  it("exits 2 with the error and the usage for an unknown command, a missing --home value, and an invalid port", async () => {
    for (const [argv, message] of [
      [["launch"], "error: unknown command 'launch'"],
      [["help"], "error: unknown command 'help'"],
      [["status", "--home"], "error: option '--home <dir>' argument missing"],
      [["daemon", "--port", "eighty"], "Invalid port: eighty"],
    ] as const) {
      const terminal = scriptedIo([]);

      // oxlint-disable-next-line no-await-in-loop -- Each command runs on its own.
      await expect(runCli(argv, terminal.io)).resolves.toBe(2);
      expect(terminal.stderr()).toContain(message);
      expect(terminal.stderr()).toContain("Usage: wheatley");
      expect(terminal.stdout()).toBe("");
    }
  });

  it("reads the backups of restore from the --home folder", async () => {
    const backup = "agent-20260101T000000000Z-pre-migration.sqlite";
    const backupsDir = path.join(home.dir, "agents", "home", "backups");

    await mkdir(backupsDir, { recursive: true });
    await writeFile(path.join(backupsDir, backup), "");

    for (const argv of [
      ["--home", home.dir, "restore", "home"],
      ["restore", "home", `--home=${home.dir}`],
    ]) {
      const terminal = scriptedIo([]);

      // oxlint-disable-next-line no-await-in-loop -- Each spelling of --home runs on its own.
      await expect(runCli(argv, terminal.io)).resolves.toBe(0);
      expect(terminal.stdout()).toContain(backup);
    }
  });
});
