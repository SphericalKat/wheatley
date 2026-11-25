import { describe, expect, it } from "vitest";

import { canonicalToolName, matchesToolPattern } from "./tool-names.js";

describe("canonicalToolName", () => {
  it("names built-in, Plugin, and MCP Tools", () => {
    expect(canonicalToolName({ kind: "builtin" }, "read_file")).toBe(
      "read_file"
    );
    expect(canonicalToolName({ kind: "plugin", plugin: "notes" }, "add")).toBe(
      "notes:add"
    );
    expect(
      canonicalToolName({ kind: "mcp", server: "github" }, "create_issue")
    ).toBe("mcp:github:create_issue");
  });

  it("rejects the reserved Plugin name and names with a colon", () => {
    expect(() =>
      canonicalToolName({ kind: "plugin", plugin: "mcp" }, "x")
    ).toThrow(RangeError);
    expect(() => canonicalToolName({ kind: "builtin" }, "notes:add")).toThrow(
      RangeError
    );
  });
});

describe("matchesToolPattern", () => {
  it.each([
    ["shell", "shell", true],
    ["shell", "shell_extra", false],
    ["notes:*", "notes:add", true],
    ["notes:*", "notebook:add", false],
    ["mcp:github:*", "mcp:github:create_issue", true],
    ["mcp:*", "mcp:slack:post", true],
    ["memory_*", "memory_write", true],
    ["*", "anything:at:all", true],
  ])("matches %s against %s: %s", (pattern, name, expected) => {
    expect(matchesToolPattern(pattern, name)).toBe(expected);
  });
});
