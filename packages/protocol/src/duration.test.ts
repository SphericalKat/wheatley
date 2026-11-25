import { parseDuration } from "@wheatley/protocol";
import { describe, expect, it } from "vitest";

describe("parseDuration", () => {
  it.each([
    ["500ms", 500],
    ["30s", 30_000],
    ["15m", 900_000],
    ["2h", 7_200_000],
    ["1d", 86_400_000],
  ])("converts %s to %i milliseconds", (text, milliseconds) => {
    expect(parseDuration(text)).toBe(milliseconds);
  });

  it.each(["15", "m", "1.5h", "-1s", "10w"])("rejects %s", (text) => {
    expect(() => parseDuration(text)).toThrow(RangeError);
  });

  it("rejects a duration beyond the safe integer range", () => {
    expect(() => parseDuration(`${"9".repeat(20)}d`)).toThrow(RangeError);
  });
});
