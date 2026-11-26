import { expect, it } from "vitest";

import { isCommandLine, matchCommands, suggestCommand } from "./commands.js";

const words = (line: string): string[] =>
  matchCommands(line).map((command) => command.word);

it("lists every command for a bare slash, built-in commands first", () => {
  expect(words("/").slice(0, 3)).toStrictEqual(["/new", "/model", "/compact"]);
  expect(words("/")).toContain("/copy");
});

it("ranks a name prefix above a name substring above a description match", () => {
  // /new and /goal match because their descriptions start with "Start".
  expect(words("/st")).toStrictEqual([
    "/stop",
    "/status",
    "/restart",
    "/new",
    "/goal",
  ]);
});

it("closes the menu once the command has an argument", () => {
  expect(words("/model gpt")).toStrictEqual([]);
});

it("suggests the closest command for a typo, and nothing for an unrelated word", () => {
  expect(suggestCommand("/stpo")).toBe("/stop");
  expect(suggestCommand("/modle")).toBe("/model");
  expect(suggestCommand("/zzzzzz")).toBeUndefined();
});

it("treats /word as a command and a path as text", () => {
  expect(isCommandLine("/stop")).toBe(true);
  expect(isCommandLine("/model gpt-5")).toBe(true);
  expect(isCommandLine("/etc/hosts has a typo")).toBe(false);
});
