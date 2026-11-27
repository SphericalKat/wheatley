import type { AvailableModel, ModelRef } from "@wheatley-ai/sdk";

/**
 * The open `/model` picker. `models` keeps the `models.list` order (by provider, then by ID). `selected` is a model of
 * `pickerMatches(picker)`, or `undefined` if no model matches the query.
 */
export interface ModelPicker {
  readonly models: readonly AvailableModel[];
  readonly current: ModelRef | undefined;
  readonly query: string;
  readonly selected: AvailableModel | undefined;
}

/** A key press in the picker that changes the query or the selection. */
export type PickerAction =
  | { readonly kind: "type"; readonly text: string }
  | { readonly kind: "erase" }
  | { readonly kind: "move"; readonly step: -1 | 1 };

/** One line of the picker list: a provider heading or a model below it. */
export type PickerRow =
  | { readonly kind: "provider"; readonly provider: string }
  | {
      readonly kind: "model";
      readonly model: AvailableModel;
      readonly current: boolean;
      readonly selected: boolean;
    };

/** The rows that fit the height, and the number of rows cut off above and below them. */
export interface PickerWindow {
  readonly rows: readonly PickerRow[];
  readonly above: number;
  readonly below: number;
}

const WORD_SPLIT = /\s+/u;
const GRAPHEMES = new Intl.Segmenter();

const isSameModel = (
  left: ModelRef | undefined,
  right: ModelRef | undefined
): boolean =>
  left !== undefined &&
  right !== undefined &&
  left.provider === right.provider &&
  left.id === right.id;

/** The models that contain every word of the query in their provider, ID, or name, ignoring case. */
export const pickerMatches = (picker: ModelPicker): AvailableModel[] => {
  const words = picker.query.toLowerCase().split(WORD_SPLIT).filter(Boolean);

  return picker.models.filter((model) => {
    const text = `${model.provider} ${model.id} ${model.name}`.toLowerCase();

    return words.every((word) => text.includes(word));
  });
};

/** Opens the picker with the current model selected, or the first model if the current model is not in the list. */
export const openPicker = (
  models: readonly AvailableModel[],
  current: ModelRef | undefined
): ModelPicker => ({
  current,
  models,
  query: "",
  selected: models.find((model) => isSameModel(model, current)) ?? models[0],
});

const withQuery = (picker: ModelPicker, query: string): ModelPicker => {
  const next = { ...picker, query };
  const matches = pickerMatches(next);

  // The selection stays on its model while the model still matches.
  const kept = matches.find((model) => isSameModel(model, picker.selected));

  return { ...next, selected: kept ?? matches[0] };
};

export const reducePicker = (
  picker: ModelPicker,
  action: PickerAction
): ModelPicker => {
  if (action.kind === "type") {
    return withQuery(picker, `${picker.query}${action.text}`);
  }

  if (action.kind === "erase") {
    const last = [...GRAPHEMES.segment(picker.query)].at(-1);

    return withQuery(
      picker,
      picker.query.slice(0, picker.query.length - (last?.segment.length ?? 0))
    );
  }

  const matches = pickerMatches(picker);

  if (matches.length === 0) {
    return picker;
  }

  const index = matches.findIndex((model) =>
    isSameModel(model, picker.selected)
  );

  const next = (index + action.step + matches.length) % matches.length;

  return { ...picker, selected: matches[next] };
};

/** The matching models, each provider group under its heading. */
export const pickerRows = (picker: ModelPicker): PickerRow[] => {
  const rows: PickerRow[] = [];
  let provider: string | undefined;

  for (const model of pickerMatches(picker)) {
    if (model.provider !== provider) {
      ({ provider } = model);
      rows.push({ kind: "provider", provider: model.provider });
    }

    rows.push({
      current: isSameModel(model, picker.current),
      kind: "model",
      model,
      selected: isSameModel(model, picker.selected),
    });
  }

  return rows;
};

/** At most `height` rows around the selected model, so the selection always shows. */
export const pickerWindow = (
  rows: readonly PickerRow[],
  height: number
): PickerWindow => {
  const size = Math.max(1, height);

  if (rows.length <= size) {
    return { above: 0, below: 0, rows };
  }

  const selected = Math.max(
    0,
    rows.findIndex((row) => row.kind === "model" && row.selected)
  );

  const start = Math.min(
    Math.max(0, selected - Math.floor(size / 2)),
    rows.length - size
  );

  return {
    above: start,
    below: rows.length - start - size,
    rows: rows.slice(start, start + size),
  };
};
