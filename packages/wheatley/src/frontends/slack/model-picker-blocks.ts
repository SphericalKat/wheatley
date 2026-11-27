import type { AvailableModel, ModelPicker, ModelRef } from "@wheatley-ai/sdk";

import { escapeMrkdwn } from "./approval-blocks.js";
import type { SlackBlocks } from "./approval-blocks.js";

/** The `action_id` prefix of the model select menus. The selected option value is `<provider>/<id>`. */
export const MODEL_ACTION_PREFIX = "wheatley_model:";

/** Block Kit limits of a `static_select` menu and its option objects. */
const MAX_OPTIONS_PER_SELECT = 100;
const MAX_OPTION_TEXT_LENGTH = 75;
const MAX_OPTION_VALUE_LENGTH = 150;
const MAX_PLACEHOLDER_LENGTH = 150;

/** Block Kit limits of an `actions` block and of one message. */
const MAX_ELEMENTS_PER_ACTIONS = 25;
const MAX_MESSAGE_BLOCKS = 50;

const ELLIPSIS = "…";

/** The models of one provider, split into pages of at most one select menu each. */
interface ProviderMenus {
  readonly provider: string;
  readonly pages: readonly (readonly AvailableModel[])[];
}

/** The value of a model option, which is also the `/model` argument. */
export const modelValue = (model: ModelRef): string =>
  `${model.provider}/${model.id}`;

/**
 * Shortens `text` to at most `max` UTF-16 code units, with an ellipsis at the end. It never splits a surrogate pair,
 * so the result is within the limit whether Slack counts code units or code points.
 */
const truncate = (text: string, max: number): string => {
  if (text.length <= max) {
    return text;
  }

  let result = "";

  for (const char of text) {
    if (result.length + char.length + ELLIPSIS.length > max) {
      break;
    }

    result += char;
  }

  return `${result}${ELLIPSIS}`;
};

const pagesOf = (
  models: readonly AvailableModel[]
): (readonly AvailableModel[])[] => {
  const pages: (readonly AvailableModel[])[] = [];

  for (let start = 0; start < models.length; start += MAX_OPTIONS_PER_SELECT) {
    pages.push(models.slice(start, start + MAX_OPTIONS_PER_SELECT));
  }

  return pages;
};

/** Groups the models by provider, in the order of the picker. */
const providerMenus = (models: readonly AvailableModel[]): ProviderMenus[] => {
  const byProvider = new Map<string, AvailableModel[]>();

  for (const model of models) {
    const group = byProvider.get(model.provider) ?? [];

    group.push(model);
    byProvider.set(model.provider, group);
  }

  return [...byProvider].map(([provider, group]) => ({
    pages: pagesOf(group),
    provider,
  }));
};

const optionOf = (model: AvailableModel) => {
  const text = {
    text: truncate(model.name, MAX_OPTION_TEXT_LENGTH),
    type: "plain_text" as const,
  };

  return model.name === model.id
    ? { text, value: modelValue(model) }
    : {
        description: {
          text: truncate(model.id, MAX_OPTION_TEXT_LENGTH),
          type: "plain_text" as const,
        },
        text,
        value: modelValue(model),
      };
};

const isCurrent = (model: AvailableModel, current: ModelRef | undefined) =>
  current !== undefined &&
  model.provider === current.provider &&
  model.id === current.id;

const placeholderOf = (menus: ProviderMenus, page: number): string =>
  menus.pages.length === 1
    ? truncate(menus.provider, MAX_PLACEHOLDER_LENGTH)
    : truncate(
        `${menus.provider} (${page + 1}/${menus.pages.length})`,
        MAX_PLACEHOLDER_LENGTH
      );

const actionsBlock = (
  menus: ProviderMenus,
  index: number,
  current: ModelRef | undefined
) => ({
  block_id: `model_picker:${index}`,
  elements: menus.pages.map((page, pageIndex) => {
    const selected = page.find((model) => isCurrent(model, current));

    return {
      action_id: `${MODEL_ACTION_PREFIX}${index}:${pageIndex}`,
      // JSON serialization drops an undefined initial option, which gives a menu with no selection.
      initial_option: selected === undefined ? undefined : optionOf(selected),
      options: page.map(optionOf),
      placeholder: {
        text: placeholderOf(menus, pageIndex),
        type: "plain_text" as const,
      },
      type: "static_select" as const,
    };
  }),
  type: "actions" as const,
});

const headerText = (current: ModelRef | undefined): string =>
  current === undefined
    ? "*Choose a model*"
    : `*Choose a model*\nCurrent model: \`${escapeMrkdwn(modelValue(current))}\``;

/** The fallback text of a model picker, for notifications and clients without Block Kit. */
export const MODEL_PICKER_TEXT = "Choose a model";

/**
 * Builds the Block Kit model picker: a section with the current model, then one `actions` block per provider with one
 * `static_select` menu per 100 models. It skips a model whose value is longer than Slack allows and adds a note that
 * names the count. Returns `undefined` if no model fits or the picker needs more blocks or menus than Slack allows,
 * so the caller can post the plain text instead.
 */
export const modelPickerBlocks = (
  picker: ModelPicker
): SlackBlocks | undefined => {
  const fitting = picker.models.filter(
    (model) => modelValue(model).length <= MAX_OPTION_VALUE_LENGTH
  );

  const skipped = picker.models.length - fitting.length;
  const menus = providerMenus(fitting);
  const noteBlocks = skipped === 0 ? 0 : 1;

  const fits =
    fitting.length > 0 &&
    1 + menus.length + noteBlocks <= MAX_MESSAGE_BLOCKS &&
    menus.every((menu) => menu.pages.length <= MAX_ELEMENTS_PER_ACTIONS);

  if (!fits) {
    return undefined;
  }

  const note =
    skipped === 0
      ? []
      : [
          {
            elements: [
              {
                text: `${skipped} ${skipped === 1 ? "model has an ID" : "models have IDs"} too long for this menu. Send \`/model <provider>/<id>\` to choose one.`,
                type: "mrkdwn" as const,
              },
            ],
            type: "context" as const,
          },
        ];

  return [
    {
      text: { text: headerText(picker.current), type: "mrkdwn" },
      type: "section",
    },
    ...menus.map((menu, index) => actionsBlock(menu, index, picker.current)),
    ...note,
  ];
};

/** The fallback text of a picker after a selection. */
export const modelSelectedText = (model: string): string =>
  `Model selected: ${model}`;

/** Builds the message that replaces the picker after a selection. It has no menus. */
export const modelSelectedBlocks = (
  model: string,
  selectedBy: string
): SlackBlocks => [
  {
    text: {
      text: `:white_check_mark: *Model selected:* \`${escapeMrkdwn(model)}\` by ${escapeMrkdwn(selectedBy)}`,
      type: "mrkdwn",
    },
    type: "section",
  },
];
