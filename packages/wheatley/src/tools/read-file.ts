import { readFile } from "node:fs/promises";

import type { Tool, ToolResult } from "@wheatley/sdk";

import { errorMessage } from "../core/error-message.js";
import { checkInput, integerField, stringField } from "./input.js";
import { resolveToolPath } from "./paths.js";

/** The largest text that `read_file` returns in one call. */
export const READ_FILE_MAX_CHARS = 100_000;

const text = (value: string, isError = false): ToolResult => ({
  content: [{ text: value, type: "text" }],
  isError,
});

/** Reads a UTF-8 text file, optionally from a line offset and for a line count. */
export const readFileTool: Tool = {
  description:
    "Read a UTF-8 text file. Relative paths resolve inside the Agent workspace. Use offset (0-based line) and limit (line count) to read part of a large file.",
  execute: async (input, ctx) => {
    const checked = checkInput(input, {
      limit: "optional-integer",
      offset: "optional-integer",
      path: "string",
    });

    if (!checked.ok) {
      return text(checked.message, true);
    }

    const target = resolveToolPath(
      ctx.workspaceDir,
      stringField(checked.value, "path") ?? ""
    );

    let content: string;

    try {
      content = await readFile(target, {
        encoding: "utf-8",
        signal: ctx.signal,
      });
    } catch (error) {
      return text(`Cannot read ${target}: ${errorMessage(error)}`, true);
    }

    const offset = integerField(checked.value, "offset");
    const limit = integerField(checked.value, "limit");

    const selected =
      offset === undefined && limit === undefined
        ? content
        : content
            .split("\n")
            .slice(
              offset ?? 0,
              limit === undefined ? undefined : (offset ?? 0) + limit
            )
            .join("\n");

    return selected.length > READ_FILE_MAX_CHARS
      ? text(
          `${selected.slice(0, READ_FILE_MAX_CHARS)}\n[truncated: the file has ${selected.length} characters; read the rest with offset and limit]`
        )
      : text(selected);
  },
  inputSchema: {
    additionalProperties: false,
    properties: {
      limit: {
        description: "The number of lines to read",
        minimum: 0,
        type: "integer",
      },
      offset: {
        description: "The first line to read, 0-based",
        minimum: 0,
        type: "integer",
      },
      path: { description: "The file path", type: "string" },
    },
    required: ["path"],
    type: "object",
  },
  name: "read_file",
};
