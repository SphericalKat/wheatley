import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { JsonValue, ToolContext, ToolResult } from "@wheatley-ai/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { silentLogger, temporaryDir } from "../core/test-support.js";
import { createBuiltinToolProvider } from "./builtin-tools.js";

let workspace: Awaited<ReturnType<typeof temporaryDir>>;

const context = (
  signal: AbortSignal = new AbortController().signal
): ToolContext => ({
  agentName: "home",
  chat: null,
  conversationId: "c1",
  log: silentLogger,
  runId: "r1",
  signal,
  toolCallId: "t1",
  workspaceDir: workspace.dir,
});

const run = async (
  name: string,
  input: JsonValue,
  signal?: AbortSignal
): Promise<ToolResult> =>
  await createBuiltinToolProvider().execute(name, input, context(signal));

const text = (result: ToolResult): string =>
  result.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");

beforeEach(async () => {
  workspace = await temporaryDir();
});

afterEach(async () => {
  await workspace.remove();
});

describe("built-in Tools", () => {
  it("offers read_file, write_file, and shell with their default actions", () => {
    expect(
      createBuiltinToolProvider()
        .tools()
        .map((tool) => [tool.name, tool.defaultAction, tool.source])
    ).toStrictEqual([
      ["read_file", "allow", "builtin"],
      ["write_file", "ask", "builtin"],
      ["shell", "ask", "builtin"],
    ]);
  });

  it("writes, appends, and reads files relative to the workspace", async () => {
    await expect(
      run("write_file", { content: "one\ntwo\n", path: "dir/file.txt" })
    ).resolves.toMatchObject({
      isError: false,
    });
    await run("write_file", {
      content: "three\n",
      mode: "append",
      path: "dir/file.txt",
    });

    await expect(
      readFile(path.join(workspace.dir, "dir", "file.txt"), "utf-8")
    ).resolves.toBe("one\ntwo\nthree\n");
    expect(text(await run("read_file", { path: "dir/file.txt" }))).toBe(
      "one\ntwo\nthree\n"
    );
    expect(
      text(
        await run("read_file", { limit: 2, offset: 1, path: "dir/file.txt" })
      )
    ).toBe("two\nthree");
  });

  it("returns error results for invalid input, missing files, and unknown Tools", async () => {
    await expect(run("read_file", { path: 3 })).resolves.toMatchObject({
      isError: true,
    });
    await expect(
      run("read_file", { extra: true, path: "a" })
    ).resolves.toMatchObject({ isError: true });
    await expect(
      run("write_file", { content: "x", mode: "prepend", path: "a" })
    ).resolves.toMatchObject({
      isError: true,
    });
    expect(text(await run("read_file", { path: "missing.txt" }))).toContain(
      "Cannot read"
    );
    await expect(run("rm_rf", {})).resolves.toMatchObject({ isError: true });
  });

  it("runs shell commands in the workspace and reports exit codes and timeouts", async () => {
    await writeFile(path.join(workspace.dir, "here.txt"), "");

    expect(await run("shell", { command: "ls && echo err >&2" })).toStrictEqual(
      {
        content: [{ text: "here.txt\nerr\n", type: "text" }],
        isError: false,
      }
    );
    expect(text(await run("shell", { command: "exit 3" }))).toContain(
      "[exit code 3]"
    );
    await expect(run("shell", { command: "exit 3" })).resolves.toMatchObject({
      isError: true,
    });
    expect(
      text(await run("shell", { command: "sleep 5", timeoutMs: 50 }))
    ).toContain("timed out after 50 ms");
  });

  it("stops a running shell command when the signal aborts", async () => {
    const abort = new AbortController();
    const running = run("shell", { command: "sleep 5" }, abort.signal);

    setTimeout(() => {
      abort.abort();
    }, 50);

    expect(text(await running)).toContain("[the command was stopped]");
  });
});
