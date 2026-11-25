import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Tool, ToolResult } from "@wheatley/sdk";

import { checkInput, stringField } from "./input.js";
import { resolveToolPath } from "./paths.js";

const text = (value: string, isError = false): ToolResult => ({
  content: [{ text: value, type: "text" }],
  isError,
});

/** Writes or appends UTF-8 text to a file and creates missing parent folders. */
export const writeFileTool: Tool = {
  description:
    'Write UTF-8 text to a file, replacing it, or append with mode "append". Relative paths resolve inside the Agent workspace. Missing folders are created.',
  execute: async (input, ctx) => {
    const checked = checkInput(input, {
      content: "string",
      mode: "optional-string",
      path: "string",
    });

    if (!checked.ok) {
      return text(checked.message, true);
    }

    const mode = stringField(checked.value, "mode") ?? "replace";

    if (mode !== "replace" && mode !== "append") {
      return text('The field mode must be "replace" or "append"', true);
    }

    const target = resolveToolPath(
      ctx.workspaceDir,
      stringField(checked.value, "path") ?? ""
    );

    const content = stringField(checked.value, "content") ?? "";

    try {
      await mkdir(path.dirname(target), { recursive: true });

      await (mode === "append"
        ? appendFile(target, content, { encoding: "utf-8" })
        : writeFile(target, content, {
            encoding: "utf-8",
            signal: ctx.signal,
          }));
    } catch (error) {
      return text(
        `Cannot write ${target}: ${error instanceof Error ? error.message : String(error)}`,
        true
      );
    }

    const verb = mode === "append" ? "Appended" : "Wrote";

    return text(
      `${verb} ${Buffer.byteLength(content, "utf-8")} bytes to ${target}`
    );
  },
  inputSchema: {
    additionalProperties: false,
    properties: {
      content: { description: "The text to write", type: "string" },
      mode: {
        description: "replace (default) or append",
        enum: ["replace", "append"],
        type: "string",
      },
      path: { description: "The file path", type: "string" },
    },
    required: ["path", "content"],
    type: "object",
  },
  name: "write_file",
};
