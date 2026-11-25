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

  it.each(["resolve-library-id", "getIssue", "browser.navigate", "get_me"])(
    "keeps the MCP Tool name %s as the server reports it",
    (tool) => {
      expect(canonicalToolName({ kind: "mcp", server: "context7" }, tool)).toBe(
        `mcp:context7:${tool}`
      );
    }
  );

  it("rejects MCP-only characters in built-in and Plugin Tool names", () => {
    expect(() => canonicalToolName({ kind: "builtin" }, "getFile")).toThrow(
      RangeError
    );
    expect(() =>
      canonicalToolName({ kind: "plugin", plugin: "notes" }, "add-note")
    ).toThrow(RangeError);
    expect(() =>
      canonicalToolName({ kind: "mcp", server: "github" }, "a:b")
    ).toThrow(RangeError);
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
    ["mcp:context7:*", "mcp:context7:resolve-library-id", true],
    ["mcp:github:getIssue", "mcp:github:getissue", false],
    ["mcp:browser:browser.navigate", "mcp:browser:browserXnavigate", false],
    ["mcp:*", "mcp:slack:post", true],
    ["memory_*", "memory_write", true],
    ["*", "anything:at:all", true],
  ])("matches %s against %s: %s", (pattern, name, expected) => {
    expect(matchesToolPattern(pattern, name)).toBe(expected);
  });
});
