import type { Models } from "@earendil-works/pi-ai";
import type { AvailableModel, ModelPicker, ModelRef } from "@wheatley-ai/sdk";

const compareText = (left: string, right: string): number =>
  left.localeCompare(right, "en");

const byProviderThenId = (left: ModelRef, right: ModelRef): number =>
  compareText(left.provider, right.provider) || compareText(left.id, right.id);

/** The chat models of every provider with a configured credential, sorted by provider, then by model ID. */
export const availableModels = async (
  models: Pick<Models, "getAvailable">
): Promise<AvailableModel[]> => {
  const available = await models.getAvailable();

  return available
    .map((model) => ({
      id: model.id,
      name: model.name,
      provider: model.provider,
    }))
    .toSorted(byProviderThenId);
};

/**
 * Parses `<provider>/<id>`. The model ID can contain more slashes, for example `openrouter/anthropic/claude`. Returns
 * `undefined` for text without a slash.
 */
export const parseModelRef = (text: string): ModelRef | undefined => {
  const slash = text.indexOf("/");

  return slash === -1
    ? undefined
    : { id: text.slice(slash + 1), provider: text.slice(0, slash) };
};

const isSameModel = (left: ModelRef | undefined, right: ModelRef): boolean =>
  left?.provider === right.provider && left.id === right.id;

/** The Markdown fallback of a `/model` reply without an argument: the current model, the list, and a switch hint. */
export const modelPickerText = (picker: ModelPicker): string => {
  const { current, models } = picker;

  const header =
    current === undefined
      ? []
      : [`Current model: ${current.provider}/${current.id}`];

  if (models.length === 0) {
    return [...header, "No providers have credentials configured."].join(
      "\n\n"
    );
  }

  const sections: string[] = [];
  let provider: string | undefined;
  let lines: string[] = [];

  for (const model of models) {
    if (model.provider !== provider) {
      if (provider !== undefined) {
        sections.push(lines.join("\n"));
      }

      ({ provider } = model);
      lines = [`**${model.provider}**`];
    }

    const marker = isSameModel(current, model) ? " (current)" : "";

    lines.push(`- ${model.id}${marker}`);
  }

  sections.push(lines.join("\n"));

  return [
    ...header,
    ...sections,
    "Use /model <id> or /model <provider>/<id> to switch.",
  ].join("\n\n");
};
