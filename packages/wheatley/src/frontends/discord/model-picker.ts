import { createHash } from "node:crypto";

import type { AvailableModel, ModelRef } from "@wheatley-ai/sdk";
import type * as DiscordJs from "discord.js";
import { Type } from "typebox";
import { Value } from "typebox/value";

import { NO_MENTIONS } from "./discord-runtime.js";
import type {
  DiscordRuntime,
  MessageRow,
  OutboundMessage,
} from "./discord-runtime.js";
import { JsonFile } from "./json-file.js";

/** Discord limits a string select to this many options. */
const MAX_SELECT_OPTIONS = 25;

/** Discord limits an option label and description to this many characters. */
const MAX_OPTION_TEXT = 100;

/** Discord limits a select placeholder to this many characters. */
const MAX_PLACEHOLDER = 150;
const CUSTOM_ID_PREFIX = "wheatley-model";
const TOKEN_LENGTH = 16;

/** The store keeps the newest pickers only. An older picker answers as no longer available. */
const MAX_STORED_PICKERS = 20;
const STORE_FILE = "model-pickers.json";
const STORE_VERSION = 1;

const DIGITS = /^\d+$/u;

/**
 * The text that tells the Sender that a picker is gone: unknown token, a token of another Chat, a finished choice,
 * or an index that the stored models do not have.
 */
export const STALE_PICKER_TEXT =
  "This model picker is no longer available. Run `/model` again.";

const ModelRefSchema = Type.Object({
  id: Type.String(),
  provider: Type.String(),
});

const PickerStateSchema = Type.Object({
  chatId: Type.String(),
  current: Type.Optional(ModelRefSchema),
  models: Type.Array(
    Type.Object({
      id: Type.String(),
      name: Type.String(),
      provider: Type.String(),
    })
  ),
  token: Type.String(),
});

const StoreFileSchema = Type.Object({
  pickers: Type.Array(PickerStateSchema),
  version: Type.Literal(STORE_VERSION),
});

/** The stored file: the newest picker states, oldest first. */
interface PickerFile {
  readonly pickers: readonly PickerState[];
  readonly version: typeof STORE_VERSION;
}

const isStoreFile = (value: unknown): value is PickerFile =>
  Value.Check(StoreFileSchema, value);

/**
 * One `/model` picker message. Component `custom_id` values and option values hold the token and indexes into
 * `models`, because a model ID can be longer than the 100 characters that Discord allows.
 */
export interface PickerState {
  readonly token: string;
  readonly chatId: string;
  readonly current?: ModelRef;
  /** Sorted by provider, then by ID, as `ModelPicker.models`. */
  readonly models: readonly AvailableModel[];
}

/** The page that a picker message shows. `provider` indexes the distinct providers of `PickerState.models`. */
export type PickerView =
  | { readonly kind: "providers"; readonly page: number }
  | {
      readonly kind: "models";
      readonly provider: number;
      readonly page: number;
    };

/** What a component of a picker message does. A select carries its choice in its values. */
type PickerAction =
  | { readonly kind: "choose_provider" }
  | { readonly kind: "choose_model" }
  | { readonly kind: "show"; readonly view: PickerView };

/** A use of a picker component. */
export interface PickerPress {
  readonly token: string;
  readonly action: PickerAction;
}

/** The result of a picker interaction: show another page, or switch to a model. */
export type PickerStep =
  | { readonly kind: "show"; readonly view: PickerView }
  | { readonly kind: "choose"; readonly model: AvailableModel };

/** A model with its index in `PickerState.models`. */
interface IndexedModel {
  readonly model: AvailableModel;
  readonly index: number;
}

/** The picker token of a delivery. The same `messageId` always gives the same token, so a retry finds its picker. */
export const pickerToken = (messageId: string): string =>
  createHash("sha256")
    .update(messageId)
    .digest("base64url")
    .slice(0, TOKEN_LENGTH);

export const modelRefText = (model: ModelRef): string =>
  `${model.provider}/${model.id}`;

const isSameModel = (left: ModelRef | undefined, right: ModelRef): boolean =>
  left?.provider === right.provider && left.id === right.id;

const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

const pageCount = (items: number): number =>
  Math.max(1, Math.ceil(items / MAX_SELECT_OPTIONS));

const pageOf = (position: number): number =>
  Math.floor(position / MAX_SELECT_OPTIONS);

const pageItems = <T>(items: readonly T[], page: number): readonly T[] =>
  items.slice(page * MAX_SELECT_OPTIONS, (page + 1) * MAX_SELECT_OPTIONS);

const providersOf = (state: PickerState): readonly string[] => [
  ...new Set(state.models.map((model) => model.provider)),
];

const modelsOf = (
  state: PickerState,
  provider: string | undefined
): readonly IndexedModel[] =>
  state.models.flatMap((model, index) =>
    model.provider === provider ? [{ index, model }] : []
  );

const isValidView = (state: PickerState, view: PickerView): boolean => {
  const providers = providersOf(state);

  if (view.kind === "providers") {
    return view.page < pageCount(providers.length);
  }

  const models = modelsOf(state, providers[view.provider]);

  return models.length > 0 && view.page < pageCount(models.length);
};

/** The first view: the page of the current model, the models of the only provider, or the first provider page. */
export const initialView = (state: PickerState): PickerView => {
  const providers = providersOf(state);
  const { current } = state;
  const provider = providers.indexOf(current?.provider ?? "");

  const position = modelsOf(state, current?.provider).findIndex(({ model }) =>
    isSameModel(current, model)
  );

  if (provider !== -1 && position !== -1) {
    return { kind: "models", page: pageOf(position), provider };
  }

  return providers.length === 1
    ? { kind: "models", page: 0, provider: 0 }
    : { kind: "providers", page: 0 };
};

const customId = (token: string, action: PickerAction): string => {
  const prefix = `${CUSTOM_ID_PREFIX}:${token}`;

  if (action.kind === "choose_provider") {
    return `${prefix}:p`;
  }

  if (action.kind === "choose_model") {
    return `${prefix}:m`;
  }

  const { view } = action;

  return view.kind === "providers"
    ? `${prefix}:v:p:${view.page}`
    : `${prefix}:v:m:${view.provider}:${view.page}`;
};

const parseIndex = (text: string | undefined): number | undefined =>
  text !== undefined && DIGITS.test(text) ? Number(text) : undefined;

const parseView = (parts: readonly string[]): PickerView | undefined => {
  const [kind, first, second, ...extra] = parts;
  const firstIndex = parseIndex(first);

  if (extra.length > 0 || firstIndex === undefined) {
    return undefined;
  }

  if (kind === "p" && second === undefined) {
    return { kind: "providers", page: firstIndex };
  }

  const page = parseIndex(second);

  return kind === "m" && page !== undefined
    ? { kind: "models", page, provider: firstIndex }
    : undefined;
};

const parseAction = (parts: readonly string[]): PickerAction | undefined => {
  const [code, ...rest] = parts;

  if (code === "p" && rest.length === 0) {
    return { kind: "choose_provider" };
  }

  if (code === "m" && rest.length === 0) {
    return { kind: "choose_model" };
  }

  const view = code === "v" ? parseView(rest) : undefined;

  return view === undefined ? undefined : { kind: "show", view };
};

/** Parses the `custom_id` of a picker component, or returns `undefined` for other components. */
export const parsePickerCustomId = (value: string): PickerPress | undefined => {
  const [prefix, token, ...rest] = value.split(":");
  const action = parseAction(rest);

  if (
    prefix !== CUSTOM_ID_PREFIX ||
    token === undefined ||
    token === "" ||
    action === undefined
  ) {
    return undefined;
  }

  return { action, token };
};

/**
 * Resolves a picker interaction against its state. `values` are the chosen option values of a select, empty for a
 * button. Returns `undefined` if the interaction does not fit the state, for example an index past the models.
 */
export const pickerStep = (
  state: PickerState,
  press: PickerPress,
  values: readonly string[]
): PickerStep | undefined => {
  const { action } = press;

  if (action.kind === "show") {
    return isValidView(state, action.view)
      ? { kind: "show", view: action.view }
      : undefined;
  }

  const index = parseIndex(values[0]);

  if (index === undefined) {
    return undefined;
  }

  if (action.kind === "choose_provider") {
    return index < providersOf(state).length
      ? { kind: "show", view: { kind: "models", page: 0, provider: index } }
      : undefined;
  }

  const model = state.models[index];

  return model === undefined ? undefined : { kind: "choose", model };
};

type Runtime = Pick<DiscordRuntime, "ButtonStyle" | "ComponentType">;

const placeholder = (noun: string, page: number, pages: number): string =>
  truncate(
    pages === 1
      ? `Choose a ${noun}`
      : `Choose a ${noun} (page ${page + 1} of ${pages})`,
    MAX_PLACEHOLDER
  );

const selectRow = (
  discord: Runtime,
  select: Omit<DiscordJs.StringSelectMenuComponentData, "type">
): MessageRow => ({
  components: [{ ...select, type: discord.ComponentType.StringSelect }],
  type: discord.ComponentType.ActionRow,
});

/** The Previous and Next buttons of one select, or none if it has one page. */
const pageButtons = (
  discord: Runtime,
  token: string,
  noun: string,
  pages: number,
  viewAt: (page: number) => PickerView,
  page: number
): DiscordJs.InteractionButtonComponentData[] => {
  if (pages === 1) {
    return [];
  }

  const button = (
    label: string,
    target: number,
    disabled: boolean
  ): DiscordJs.InteractionButtonComponentData => ({
    customId: customId(token, { kind: "show", view: viewAt(target) }),
    disabled,
    label,
    style: discord.ButtonStyle.Secondary,
    type: discord.ComponentType.Button,
  });

  // At an edge the disabled button targets a neighbor page, so the two `custom_id` values stay distinct.
  return [
    button(`Previous ${noun}s`, Math.max(0, page - 1), page === 0),
    button(`Next ${noun}s`, Math.min(pages - 1, page + 1), page === pages - 1),
  ];
};

/**
 * Builds the picker message for a view: a provider select, the model select of the shown provider, and a row of
 * page buttons when a select has more than 25 options. At most three action rows.
 */
export const pickerMessage = (
  discord: Runtime,
  state: PickerState,
  view: PickerView
): OutboundMessage => {
  const { token, current } = state;
  const providers = providersOf(state);
  const providerPages = pageCount(providers.length);
  const shown = view.kind === "models" ? view.provider : undefined;

  const providerPage =
    view.kind === "models" ? pageOf(view.provider) : view.page;

  const rows: MessageRow[] = [
    selectRow(discord, {
      customId: customId(token, { kind: "choose_provider" }),
      options: pageItems(
        providers.map((name, index) => ({ index, name })),
        providerPage
      ).map(({ index, name }) => ({
        default: index === shown,
        label: truncate(name, MAX_OPTION_TEXT),
        value: String(index),
      })),
      placeholder: placeholder("provider", providerPage, providerPages),
    }),
  ];

  const buttons = pageButtons(
    discord,
    token,
    "provider",
    providerPages,
    (page) => ({ kind: "providers", page }),
    providerPage
  );

  if (view.kind === "models") {
    const models = modelsOf(state, providers[view.provider]);
    const modelPages = pageCount(models.length);

    rows.push(
      selectRow(discord, {
        customId: customId(token, { kind: "choose_model" }),
        options: pageItems(models, view.page).map(({ index, model }) => ({
          default: isSameModel(current, model),
          description:
            model.name === model.id
              ? undefined
              : truncate(model.id, MAX_OPTION_TEXT),
          label: truncate(model.name, MAX_OPTION_TEXT),
          value: String(index),
        })),
        placeholder: placeholder("model", view.page, modelPages),
      })
    );
    buttons.push(
      ...pageButtons(
        discord,
        token,
        "model",
        modelPages,
        (page) => ({ kind: "models", page, provider: view.provider }),
        view.page
      )
    );
  }

  if (buttons.length > 0) {
    rows.push({ components: buttons, type: discord.ComponentType.ActionRow });
  }

  return {
    allowedMentions: NO_MENTIONS,
    components: rows,
    content:
      current === undefined
        ? "Choose a model."
        : `Current model: \`${modelRefText(current)}\``,
  };
};

/**
 * Keeps the newest picker states in the binding's `dataDir`, so that a picker still works after a daemon restart and
 * a retried delivery finds the picker that it already sent.
 */
export class PickerStore {
  readonly #file: JsonFile<PickerFile>;
  /** In insertion order, oldest first. */
  readonly #pickers = new Map<string, PickerState>();

  constructor(dataDir: string) {
    this.#file = new JsonFile(dataDir, STORE_FILE, isStoreFile);
  }

  /** Reads the file. A missing file means no pickers. Throws for an unreadable or malformed file. */
  async load(): Promise<void> {
    const parsed = await this.#file.read();

    if (parsed === undefined) {
      return;
    }

    this.#pickers.clear();

    for (const picker of parsed.pickers) {
      this.#pickers.set(picker.token, picker);
    }
  }

  get(token: string): PickerState | undefined {
    return this.#pickers.get(token);
  }

  /** Stores a picker, drops the oldest beyond the limit, and resolves once the file holds the result. */
  async put(state: PickerState): Promise<void> {
    this.#pickers.set(state.token, state);

    for (const token of this.#pickers.keys()) {
      if (this.#pickers.size <= MAX_STORED_PICKERS) {
        break;
      }

      this.#pickers.delete(token);
    }

    await this.#persist();
  }

  /** Removes a picker and resolves once the file no longer holds it. */
  async delete(token: string): Promise<void> {
    if (this.#pickers.delete(token)) {
      await this.#persist();
    }
  }

  async #persist(): Promise<void> {
    await this.#file.write({
      pickers: [...this.#pickers.values()],
      version: STORE_VERSION,
    });
  }
}
