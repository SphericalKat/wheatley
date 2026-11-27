import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxGroupLabel,
  ComboboxInput,
  ComboboxItem,
  ComboboxItemIndicator,
  ComboboxList,
  ComboboxTrigger,
} from "@ui-sdk/react/combobox";
import type { MethodResult } from "@wheatley-ai/protocol";
import { useState } from "react";

import { useEvent, useRpcQuery, useServices } from "../hooks.js";
import {
  modelPickerView,
  modelsOf,
  providersOf,
} from "../models/model-picker.js";
import type { ModelChoice } from "../models/model-picker.js";
import { errorMessage } from "../store.js";
import { buttonClass, inputClass } from "./ui.js";

type ModelsList = MethodResult<"models.list">;

/** A choice that waits for `models.list` to confirm it. `basis` is the result that was current when it started. */
interface PendingChoice {
  readonly value: string;
  readonly basis: ModelsList;
}

const ChoiceRow = ({ choice }: { readonly choice: ModelChoice }) => (
  <ComboboxItem
    className="flex cursor-default items-center gap-2 rounded px-2 py-1 data-[highlighted]:bg-zinc-100 dark:data-[highlighted]:bg-zinc-800"
    label={choice.name}
    value={choice.value}
  >
    <span className="w-4 shrink-0 text-indigo-600 dark:text-indigo-400">
      <ComboboxItemIndicator />
    </span>
    <span className="min-w-0 flex-1">
      <span className="block truncate">{choice.name}</span>
      <span className="block truncate font-mono text-xs text-zinc-500">
        {choice.id}
      </span>
    </span>
  </ComboboxItem>
);

/**
 * The model of the Agent's CLI Chat Conversation, and a searchable list of the available models by provider. A choice
 * runs `/model <provider>/<id>`. The Agent's reply arrives in the Chat.
 */
export const ModelPicker = ({ agent }: { readonly agent: string }) => {
  const { client } = useServices();

  const models = useRpcQuery(
    "models.list",
    { agent },
    { agent, refreshOn: ["agent.status"] }
  );

  const [search, setSearch] = useState("");
  const [pending, setPending] = useState<PendingChoice | null>(null);
  const [chooseError, setChooseError] = useState<string | null>(null);
  const [button, setButton] = useState<HTMLButtonElement | null>(null);
  const { data, refresh } = models;

  // Each command reply can follow a new Conversation or model, for example after `/new` or `/model` in the composer.
  useEvent("chat.message", ({ agent: about, message }) => {
    if (about === agent && message.source === "command") {
      refresh();
    }
  });

  if (data === null) {
    return models.error === null ? (
      <span className="text-sm text-zinc-500">Loading models…</span>
    ) : (
      <span className="text-sm text-red-600" role="alert">
        {models.error}
      </span>
    );
  }

  // A pending choice shows until the next `models.list` result replaces the result it started from.
  const view = modelPickerView(
    data,
    search,
    pending?.basis === data ? pending.value : undefined
  );

  if (view.kind === "no-models") {
    return (
      <span className="text-sm text-zinc-500">
        No provider has credentials.
      </span>
    );
  }

  if (view.kind === "stopped") {
    return (
      <span className="text-sm text-zinc-500">
        Start the Agent to choose a model.
      </span>
    );
  }

  const { current } = view;

  const choose = async (value: string): Promise<void> => {
    setPending({ basis: data, value });
    setChooseError(null);

    try {
      await client.call("chat.command", { agent, args: value, name: "model" });
    } catch (error) {
      setChooseError(errorMessage(error));
    }

    refresh();
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <Combobox
        filter={false}
        onOpenChange={(open) => {
          if (open) {
            setSearch("");
          }
        }}
        onOpenChangeComplete={(open) => {
          if (!open) {
            button?.focus();
          }
        }}
        onQueryChange={setSearch}
        onValueChange={(next) => {
          if (next !== null && next !== current.value) {
            void choose(next);
          }
        }}
        query={search}
        value={current.value}
      >
        <ComboboxTrigger
          aria-label="Model"
          className={`${buttonClass("neutral")} max-w-72`}
          ref={setButton}
        >
          <span className="truncate">{current.name}</span>
          <span className="text-xs text-zinc-500">{current.provider}</span>
        </ComboboxTrigger>
        <ComboboxContent
          align="end"
          anchor={button}
          className="z-10 w-[min(22rem,90vw)] space-y-1 rounded-md border border-zinc-200 bg-white p-1 text-sm text-zinc-900 shadow-lg dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
          sideOffset={4}
        >
          <ComboboxInput
            aria-label="Search models"
            autoFocus
            className={inputClass}
            placeholder="Search models…"
          />
          <ComboboxEmpty className="hidden px-2 py-3 text-center text-zinc-500 data-[empty]:block">
            No model matches.
          </ComboboxEmpty>
          <ComboboxList className="max-h-80 overflow-y-auto">
            {view.groups.map((group) => (
              <ComboboxGroup className="py-1" key={group.provider}>
                <ComboboxGroupLabel className="px-2 py-1 text-xs font-semibold tracking-wide text-zinc-500 uppercase">
                  {group.provider}
                </ComboboxGroupLabel>
                {group.choices.map((choice) => (
                  <ChoiceRow choice={choice} key={choice.value} />
                ))}
              </ComboboxGroup>
            ))}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
      {chooseError === null ? null : (
        <span className="text-sm text-red-600" role="alert">
          {chooseError}
        </span>
      )}
    </div>
  );
};

/**
 * Datalists for free-text model inputs: the providers with a credential plus `extraProviders`, and the model IDs of
 * `provider`, from `models.list`.
 */
export const ModelSuggestions = ({
  extraProviders = [],
  modelsId,
  provider,
  providersId,
}: {
  readonly providersId: string;
  readonly modelsId: string;
  readonly provider: string;
  readonly extraProviders?: readonly string[];
}) => {
  const models = useRpcQuery("models.list", {}).data?.models ?? [];
  const providers = [...new Set([...providersOf(models), ...extraProviders])];

  return (
    <>
      <datalist id={providersId}>
        {providers.map((entry) => (
          <option key={entry} value={entry} />
        ))}
      </datalist>
      <datalist id={modelsId}>
        {modelsOf(models, provider).map((model) => (
          <option key={model.id} label={model.name} value={model.id} />
        ))}
      </datalist>
    </>
  );
};
