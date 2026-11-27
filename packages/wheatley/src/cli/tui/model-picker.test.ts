import { expect, it } from "vitest";

import {
  openPicker,
  pickerRows,
  pickerWindow,
  reducePicker,
} from "./model-picker.js";
import type { ModelPicker, PickerAction, PickerRow } from "./model-picker.js";

const MODELS = [
  { id: "claude-opus", name: "Claude Opus", provider: "anthropic" },
  { id: "claude-sonnet", name: "Claude Sonnet", provider: "anthropic" },
  { id: "gpt-6", name: "GPT-6", provider: "openai" },
  {
    id: "anthropic/claude-opus",
    name: "Anthropic: Claude Opus",
    provider: "openrouter",
  },
] as const;

const apply = (
  picker: ModelPicker,
  actions: readonly PickerAction[]
): ModelPicker => {
  let next = picker;

  for (const action of actions) {
    next = reducePicker(next, action);
  }

  return next;
};

/** Typed text arrives as one key press, as fast typing or a paste does. */
const typed = (text: string): PickerAction[] => [{ kind: "type", text }];

const label = (row: PickerRow): string =>
  row.kind === "provider"
    ? row.provider
    : `${row.selected ? "›" : " "} ${row.model.id}${row.current ? " (current)" : ""}`;

const lines = (picker: ModelPicker): string[] => pickerRows(picker).map(label);

const selectedId = (picker: ModelPicker): string | undefined =>
  picker.selected === undefined
    ? undefined
    : `${picker.selected.provider}/${picker.selected.id}`;

it("groups models by provider and starts on the current model", () => {
  const picker = openPicker(MODELS, { id: "gpt-6", provider: "openai" });

  expect(lines(picker)).toStrictEqual([
    "anthropic",
    "  claude-opus",
    "  claude-sonnet",
    "openai",
    "› gpt-6 (current)",
    "openrouter",
    "  anthropic/claude-opus",
  ]);
});

it("starts on the first model if the current model is unknown or missing", () => {
  expect(selectedId(openPicker(MODELS, undefined))).toBe(
    "anthropic/claude-opus"
  );
  expect(
    selectedId(openPicker(MODELS, { id: "gone", provider: "openai" }))
  ).toBe("anthropic/claude-opus");
});

it("filters on provider, ID, and display name, ignoring case and word order", () => {
  const picker = openPicker(MODELS, undefined);

  expect(lines(apply(picker, typed("OPENAI")))).toStrictEqual([
    "openai",
    "› gpt-6",
  ]);
  expect(lines(apply(picker, typed("sonnet")))).toStrictEqual([
    "anthropic",
    "› claude-sonnet",
  ]);
  expect(lines(apply(picker, typed("opus router")))).toStrictEqual([
    "openrouter",
    "› anthropic/claude-opus",
  ]);
  expect(lines(apply(picker, typed("Anthropic: C")))).toStrictEqual([
    "openrouter",
    "› anthropic/claude-opus",
  ]);
});

it("keeps the selected model while it still matches, and erases the query one character at a time", () => {
  const onSonnet = apply(openPicker(MODELS, undefined), [
    { kind: "move", step: 1 },
  ]);

  expect(selectedId(apply(onSonnet, typed("claude")))).toBe(
    "anthropic/claude-sonnet"
  );
  expect(selectedId(apply(onSonnet, typed("gpt")))).toBe("openai/gpt-6");

  const erased = apply(onSonnet, [...typed("gptx"), { kind: "erase" }]);

  expect(erased.query).toBe("gpt");
  expect(selectedId(erased)).toBe("openai/gpt-6");
  expect(apply(onSonnet, [...typed("gpt👍🏽"), { kind: "erase" }]).query).toBe(
    "gpt"
  );
});

it("selects nothing when no model matches and selects again when the query matches", () => {
  const none = apply(openPicker(MODELS, undefined), typed("zzz"));

  expect(none.selected).toBeUndefined();
  expect(pickerRows(none)).toStrictEqual([]);
  expect(reducePicker(none, { kind: "move", step: 1 })).toBe(none);

  const back = apply(none, [
    { kind: "erase" },
    { kind: "erase" },
    { kind: "erase" },
  ]);

  expect(selectedId(back)).toBe("anthropic/claude-opus");
});

it("moves through the matches across provider groups and wraps at both ends", () => {
  const picker = openPicker(MODELS, undefined);

  expect(selectedId(reducePicker(picker, { kind: "move", step: -1 }))).toBe(
    "openrouter/anthropic/claude-opus"
  );
  expect(
    selectedId(
      apply(picker, [
        { kind: "move", step: 1 },
        { kind: "move", step: 1 },
      ])
    )
  ).toBe("openai/gpt-6");
  expect(
    selectedId(apply(picker, [...typed("claude"), { kind: "move", step: 1 }]))
  ).toBe("anthropic/claude-sonnet");
});

const MANY_MODELS = 300;
const HEIGHT = 10;

it("shows at most the given height of rows, always with the selected model, and counts the rows cut off", () => {
  const many = Array.from({ length: MANY_MODELS }, (_, index) => ({
    id: `m-${String(index).padStart(3, "0")}`,
    name: `Model ${index}`,
    provider: "big",
  }));

  const middle = openPicker(many, { id: "m-150", provider: "big" });
  const window = pickerWindow(pickerRows(middle), HEIGHT);

  expect(window.rows).toHaveLength(HEIGHT);
  expect(window.rows.map(label)).toContain("› m-150 (current)");
  expect(window.above + window.rows.length + window.below).toBe(
    MANY_MODELS + 1
  );

  const top = pickerWindow(pickerRows(openPicker(many, undefined)), HEIGHT);

  expect(top.above).toBe(0);
  expect(top.rows.map(label).slice(0, 2)).toStrictEqual(["big", "› m-000"]);

  const last = apply(openPicker(many, undefined), [{ kind: "move", step: -1 }]);
  const bottom = pickerWindow(pickerRows(last), HEIGHT);

  expect(bottom.below).toBe(0);
  expect(bottom.rows.map(label).at(-1)).toBe("› m-299");
});

it("shows every row without cut-off counts when the rows fit", () => {
  const rows = pickerRows(openPicker(MODELS, undefined));

  expect(pickerWindow(rows, HEIGHT)).toStrictEqual({
    above: 0,
    below: 0,
    rows,
  });
});
