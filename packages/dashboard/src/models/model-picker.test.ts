import type { AvailableModel } from "@wheatley-ai/protocol";
import { expect, test } from "vitest";

import { modelGroups, modelPickerView, modelsOf } from "./model-picker.js";

const MODELS: readonly AvailableModel[] = [
  { id: "claude-opus-4-5", name: "Claude Opus 4.5", provider: "anthropic" },
  { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", provider: "anthropic" },
  { id: "gpt-5", name: "GPT-5", provider: "openai" },
  {
    id: "anthropic/claude-sonnet-4.5",
    name: "Anthropic: Claude Sonnet 4.5",
    provider: "openrouter",
  },
];

const values = (search: string) =>
  modelGroups(MODELS, search).map((group) => [
    group.provider,
    group.choices.map((choice) => choice.value),
  ]);

test("groups every model by provider for an empty search", () => {
  expect(values("")).toEqual([
    ["anthropic", ["anthropic/claude-opus-4-5", "anthropic/claude-sonnet-4-5"]],
    ["openai", ["openai/gpt-5"]],
    ["openrouter", ["openrouter/anthropic/claude-sonnet-4.5"]],
  ]);
});

test("keeps the models whose argument or name holds every search word, in any case", () => {
  expect(values("SONNET anthropic")).toEqual([
    ["anthropic", ["anthropic/claude-sonnet-4-5"]],
    ["openrouter", ["openrouter/anthropic/claude-sonnet-4.5"]],
  ]);
  expect(values("openai/")).toEqual([["openai", ["openai/gpt-5"]]]);
  expect(values("Opus 4.5")).toEqual([
    ["anthropic", ["anthropic/claude-opus-4-5"]],
  ]);
});

test("gives no groups if no model matches", () => {
  expect(modelGroups(MODELS, "gemini")).toEqual([]);
});

test("names the current model with its display name", () => {
  const view = modelPickerView(
    { current: { id: "gpt-5", provider: "openai" }, models: MODELS },
    ""
  );

  expect(view.kind === "ready" ? view.current : view).toEqual({
    id: "gpt-5",
    name: "GPT-5",
    provider: "openai",
    value: "openai/gpt-5",
  });
});

test("names a current model that is not in the list with its ID", () => {
  const view = modelPickerView(
    { current: { id: "old-model", provider: "anthropic" }, models: MODELS },
    ""
  );

  expect(view.kind === "ready" ? view.current : view).toEqual({
    id: "old-model",
    name: "old-model",
    provider: "anthropic",
    value: "anthropic/old-model",
  });
});

test("shows a pending choice as chosen until the Agent confirms or rejects it", () => {
  const result = {
    current: { id: "gpt-5", provider: "openai" },
    models: MODELS,
  };

  const shown = (pending: string) => {
    const view = modelPickerView(result, "", pending);

    return view.kind === "ready" ? view.current.value : view.kind;
  };

  expect(shown("openrouter/anthropic/claude-sonnet-4.5")).toBe(
    "openrouter/anthropic/claude-sonnet-4.5"
  );
  expect(shown("openai/unknown")).toBe("openai/gpt-5");
});

test("reports a stopped Agent and a Deployment without models", () => {
  expect(modelPickerView({ models: MODELS }, "")).toEqual({ kind: "stopped" });
  expect(
    modelPickerView(
      { current: { id: "gpt-5", provider: "openai" }, models: [] },
      ""
    )
  ).toEqual({ kind: "no-models" });
});

test("gives the models of one provider", () => {
  expect(modelsOf(MODELS, "openai").map((model) => model.id)).toEqual([
    "gpt-5",
  ]);
  expect(modelsOf(MODELS, "unknown")).toEqual([]);
});
