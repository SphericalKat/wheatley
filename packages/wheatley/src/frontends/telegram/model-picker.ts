import type { AvailableModel, ModelPicker } from "@wheatley-ai/sdk";
import { Type } from "typebox";
import type { Static } from "typebox";

import type { InlineButton } from "./client.js";
import { escapeHtml } from "./markdown.js";
import { shortToken, TokenStore } from "./token-store.js";

const STORE_FILE = "model-pickers.json";

/** Older pickers stop working once this many newer pickers exist. */
const STORE_CAPACITY = 50;

/** Models per page of the model step. */
const MODEL_PAGE_SIZE = 8;

const CALLBACK_PREFIX = "mp";

const CALLBACK_DATA =
  /^mp:(?<token>[\w-]+):(?:(?<providers>p)|m:(?<provider>\d+):(?<page>\d+)|s:(?<model>\d+))$/u;

const CURRENT_MARK = "✓ ";

const ModelRefSchema = Type.Object({
  id: Type.String(),
  provider: Type.String(),
});

const PickerSchema = Type.Object({
  /** The Chat key of the picker message. A press in another Chat is stale. */
  chatId: Type.String(),
  current: Type.Optional(ModelRefSchema),
  /** Sorted by provider, then by ID, as `ModelPicker.models`. Callback data refers to models by index. */
  models: Type.Array(
    Type.Object({
      id: Type.String(),
      name: Type.String(),
      provider: Type.String(),
    })
  ),
});

/** One `/model` picker message, by its callback token. */
export type StoredPicker = Static<typeof PickerSchema>;

/** The step that a picker message shows. `provider` indexes `providersOf(picker)`. */
export type PickerView =
  | { readonly kind: "providers" }
  | {
      readonly kind: "models";
      readonly provider: number;
      readonly page: number;
    };

/** What a picker button does. `model` indexes `StoredPicker.models`. */
export type PickerAction =
  | { readonly kind: "show"; readonly view: PickerView }
  | { readonly kind: "select"; readonly model: number };

/** The HTML text and keyboard of a picker message. */
export interface PickerScreen {
  readonly text: string;
  readonly keyboard: readonly (readonly InlineButton[])[];
}

/** Returns the callback token of the picker of an outbox message. */
export const pickerToken = (messageId: string): string => shortToken(messageId);

export const toStoredPicker = (
  chatId: string,
  picker: ModelPicker
): StoredPicker => ({
  chatId,
  current:
    picker.current === undefined
      ? undefined
      : { id: picker.current.id, provider: picker.current.provider },
  models: picker.models.map(({ id, name, provider }) => ({
    id,
    name,
    provider,
  })),
});

/** The distinct providers of a picker, in model order. */
const providersOf = (picker: StoredPicker): readonly string[] => [
  ...new Set(picker.models.map((model) => model.provider)),
];

const isCurrent = (picker: StoredPicker, model: AvailableModel): boolean =>
  picker.current?.provider === model.provider && picker.current.id === model.id;

const encode = (token: string, action: PickerAction): string => {
  if (action.kind === "select") {
    return `${CALLBACK_PREFIX}:${token}:s:${action.model}`;
  }

  const { view } = action;

  return view.kind === "providers"
    ? `${CALLBACK_PREFIX}:${token}:p`
    : `${CALLBACK_PREFIX}:${token}:m:${view.provider}:${view.page}`;
};

const button = (
  token: string,
  text: string,
  action: PickerAction
): InlineButton => ({ callbackData: encode(token, action), text });

/** Parses the callback data of a picker button. Returns `undefined` for other callback data. */
export const parsePickerCallback = (
  data: string
): { readonly token: string; readonly action: PickerAction } | undefined => {
  const groups = CALLBACK_DATA.exec(data)?.groups;

  if (groups?.token === undefined) {
    return undefined;
  }

  const { token } = groups;

  if (groups.model !== undefined) {
    return { action: { kind: "select", model: Number(groups.model) }, token };
  }

  if (groups.providers !== undefined) {
    return { action: { kind: "show", view: { kind: "providers" } }, token };
  }

  return {
    action: {
      kind: "show",
      view: {
        kind: "models",
        page: Number(groups.page),
        provider: Number(groups.provider),
      },
    },
    token,
  };
};

const headerOf = (picker: StoredPicker): string =>
  picker.current === undefined
    ? "<b>Choose a model</b>"
    : `<b>Choose a model</b>\nCurrent: <code>${escapeHtml(`${picker.current.provider}/${picker.current.id}`)}</code>`;

const providersScreen = (token: string, picker: StoredPicker): PickerScreen => {
  const providers = providersOf(picker);

  const keyboard = providers.map((provider, index) => {
    const count = picker.models.filter(
      (model) => model.provider === provider
    ).length;

    const mark = picker.current?.provider === provider ? CURRENT_MARK : "";

    return [
      button(token, `${mark}${provider} (${count})`, {
        kind: "show",
        view: { kind: "models", page: 0, provider: index },
      }),
    ];
  });

  return { keyboard, text: `${headerOf(picker)}\nChoose a provider.` };
};

const modelsOf = (
  picker: StoredPicker,
  provider: string | undefined
): readonly (readonly [number, StoredPicker["models"][number]])[] =>
  [...picker.models.entries()].filter(
    ([, model]) => model.provider === provider
  );

const pageCount = (models: number): number =>
  Math.ceil(models / MODEL_PAGE_SIZE);

const modelsScreen = (
  token: string,
  picker: StoredPicker,
  view: Extract<PickerView, { kind: "models" }>
): PickerScreen => {
  const providers = providersOf(picker);
  const provider = providers[view.provider] ?? "";
  const entries = modelsOf(picker, provider);
  const pages = pageCount(entries.length);
  const start = view.page * MODEL_PAGE_SIZE;

  const rows = entries
    .slice(start, start + MODEL_PAGE_SIZE)
    .map(([index, model]) => [
      button(
        token,
        `${isCurrent(picker, model) ? CURRENT_MARK : ""}${model.name}`,
        { kind: "select", model: index }
      ),
    ]);

  const pageAt = (page: number): PickerAction => ({
    kind: "show",
    view: { kind: "models", page, provider: view.provider },
  });

  const navigation = [
    ...(view.page > 0
      ? [button(token, "Previous", pageAt(view.page - 1))]
      : []),
    ...(view.page < pages - 1
      ? [button(token, "Next", pageAt(view.page + 1))]
      : []),
  ];

  const back =
    providers.length > 1
      ? [
          button(token, "Back", {
            kind: "show",
            view: { kind: "providers" },
          }),
        ]
      : [];

  const keyboard = [...rows, navigation, back].filter((row) => row.length > 0);
  const pageText = pages > 1 ? `, page ${view.page + 1} of ${pages}` : "";

  return {
    keyboard,
    text: `${headerOf(picker)}\n<b>${escapeHtml(provider)}</b>${pageText}`,
  };
};

/** The first screen: the provider step, or the model step if only one provider has models. */
export const openingScreen = (
  token: string,
  picker: StoredPicker
): PickerScreen =>
  providersOf(picker).length > 1
    ? providersScreen(token, picker)
    : modelsScreen(token, picker, { kind: "models", page: 0, provider: 0 });

/** The screen of a pressed step. Returns `undefined` if `view` points past the picker's providers or pages. */
export const pickerScreen = (
  token: string,
  picker: StoredPicker,
  view: PickerView
): PickerScreen | undefined => {
  if (view.kind === "providers") {
    return providersScreen(token, picker);
  }

  const provider = providersOf(picker)[view.provider];
  const pages = pageCount(modelsOf(picker, provider).length);

  return provider === undefined || view.page >= pages
    ? undefined
    : modelsScreen(token, picker, view);
};

/** The HTML text that replaces a picker message after a selection. */
export const pickerSelectedText = (model: AvailableModel): string =>
  `Selected <code>${escapeHtml(`${model.provider}/${model.id}`)}</code>`;

/** Creates the picker store of a binding, in `model-pickers.json` of its data directory. */
export const createPickerStore = (
  dataDir: string
): TokenStore<typeof PickerSchema> =>
  new TokenStore({
    capacity: STORE_CAPACITY,
    dataDir,
    file: STORE_FILE,
    schema: PickerSchema,
  });

/** The picker store of a binding. */
export type PickerStore = ReturnType<typeof createPickerStore>;
