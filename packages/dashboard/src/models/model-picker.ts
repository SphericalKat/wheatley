import type { AvailableModel, ModelRef } from "@wheatley-ai/protocol";

/** A model that the Operator can choose. `value` is the `/model` argument, `<provider>/<id>`. */
export interface ModelChoice {
  readonly value: string;
  readonly provider: string;
  readonly id: string;
  /** The display name, or the ID if the model is not in the list, for example after its credential was removed. */
  readonly name: string;
}

/** The choices of one provider, in the order of `models.list`. */
export interface ModelGroup {
  readonly provider: string;
  readonly choices: readonly ModelChoice[];
}

/** What the chat view shows for a `models.list` result. */
export type ModelPickerView =
  /** No provider has a credential, so the Agent cannot use any model. */
  | { readonly kind: "no-models" }
  /** The Agent does not run, so its CLI Chat Conversation has no model. */
  | { readonly kind: "stopped" }
  | {
      readonly kind: "ready";
      /** The model to show as chosen: the pending choice, or else the model of the Conversation. */
      readonly current: ModelChoice;
      /** The groups with at least one choice that matches the search text. */
      readonly groups: readonly ModelGroup[];
    };

const WHITESPACE = /\s+/u;

/** Returns the `/model` argument of a model. Model IDs can contain `/`, and the Agent splits at the first `/`. */
export const modelArgument = (model: ModelRef): string =>
  `${model.provider}/${model.id}`;

const toChoice = (model: AvailableModel): ModelChoice => ({
  id: model.id,
  name: model.name,
  provider: model.provider,
  value: modelArgument(model),
});

/** Whether every word of `search` occurs in the argument or the name of `choice`, without regard to case. */
const matches = (choice: ModelChoice, words: readonly string[]): boolean => {
  const text = `${choice.value} ${choice.name}`.toLowerCase();

  return words.every((word) => text.includes(word));
};

/** Groups the models that match `search` by provider. `models` is sorted by provider, as `models.list` returns it. */
export const modelGroups = (
  models: readonly AvailableModel[],
  search: string
): readonly ModelGroup[] => {
  const words = search.toLowerCase().split(WHITESPACE).filter(Boolean);
  const groups: { provider: string; choices: ModelChoice[] }[] = [];

  for (const model of models) {
    const choice = toChoice(model);

    if (!matches(choice, words)) {
      continue;
    }

    const last = groups.at(-1);

    if (last?.provider === choice.provider) {
      last.choices.push(choice);
    } else {
      groups.push({ choices: [choice], provider: choice.provider });
    }
  }

  return groups;
};

/**
 * Returns the picker state for a `models.list` result, the search text of the picker, and the `value` of a choice that
 * the Agent did not confirm yet.
 */
export const modelPickerView = (
  result: {
    readonly current?: ModelRef;
    readonly models: readonly AvailableModel[];
  },
  search: string,
  pending?: string
): ModelPickerView => {
  const { current, models } = result;

  if (models.length === 0) {
    return { kind: "no-models" };
  }

  if (current === undefined) {
    return { kind: "stopped" };
  }

  const shown =
    models.find((model) => modelArgument(model) === pending) ??
    models.find(
      (model) => model.provider === current.provider && model.id === current.id
    );

  return {
    current: toChoice(shown ?? { ...current, name: current.id }),
    groups: modelGroups(models, search),
    kind: "ready",
  };
};

/** Returns the providers of `models` once each, in list order. */
export const providersOf = (
  models: readonly AvailableModel[]
): readonly string[] => [...new Set(models.map((model) => model.provider))];

/** Returns the models of `provider`. */
export const modelsOf = (
  models: readonly AvailableModel[],
  provider: string
): readonly AvailableModel[] =>
  models.filter((model) => model.provider === provider);
