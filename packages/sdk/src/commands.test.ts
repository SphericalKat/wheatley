import { BUILTIN_COMMANDS, parseCommandText } from "@wheatley/sdk";
import { describe, expect, it } from "vitest";

describe("parseCommandText", () => {
  it("parses a command with an argument", () => {
    expect(parseCommandText("/model  gpt-6-sol ")).toStrictEqual({
      args: "gpt-6-sol",
      name: "model",
    });
  });

  it("parses a command without an argument", () => {
    expect(parseCommandText("/new")).toStrictEqual({
      args: undefined,
      name: "new",
    });
  });

  it("accepts a Telegram bot suffix", () => {
    expect(parseCommandText("/stop@wheatley_bot")).toStrictEqual({
      args: undefined,
      name: "stop",
    });
  });

  it("keeps multi-line goal objectives", () => {
    expect(parseCommandText("/goal plan the trip\nwith hotels")?.args).toBe(
      "plan the trip\nwith hotels"
    );
  });

  it("returns undefined for text that is not a built-in command", () => {
    expect(parseCommandText("/unknown")).toBeUndefined();
    expect(parseCommandText("a path like /new is text")).toBeUndefined();
  });

  it("lists the seven built-in commands", () => {
    expect(BUILTIN_COMMANDS.map((command) => command.name)).toStrictEqual([
      "new",
      "model",
      "compact",
      "stop",
      "goal",
      "status",
      "restart",
    ]);
  });
});
