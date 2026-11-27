import { useNavigate } from "@tanstack/react-router";
import { AgentNameSchema, decode } from "@wheatley-ai/protocol";
import { useId, useState } from "react";

import { useServices, useStore } from "../hooks.js";
import type {
  AgentDataDisposal,
  ConfigChange,
} from "../models/config-editor.js";
import { ModelSuggestions } from "./model-picker.js";
import {
  ActionButton,
  ConfirmButton,
  Field,
  inputClass,
  Notice,
} from "./ui.js";

const AGENT_NAME_HINT =
  "Lowercase letters, digits, and hyphens. It must start with a letter. The name is also the folder name.";

const isAgentName = (name: string): boolean => decode(AgentNameSchema, name).ok;

/** Saves a change through the Config model and throws its error, so the dialog stays open and shows it. */
const useSaveOrThrow = (): ((change: ConfigChange) => Promise<void>) => {
  const { config } = useServices();

  return async (change) => {
    if (await config.save(change)) {
      return;
    }

    const { conflict, saveError } = config.state.get();

    if (conflict !== null) {
      throw new Error(
        "config.yaml changed after the dashboard loaded it. Choose Reload or Overwrite in the conflict message."
      );
    }

    throw new Error(saveError ?? "The daemon did not save the change.");
  };
};

/** Shows a pending revision conflict with Reload and Overwrite on every page. */
export const ConflictBanner = () => {
  const { config } = useServices();
  const { conflict, remoteChanged } = useStore(config.state);

  if (conflict === null) {
    return remoteChanged ? (
      <Notice>
        config.yaml changed on the daemon while the raw YAML editor has unsaved
        edits. Save to see the conflict, or discard the edits in the Config
        view.
      </Notice>
    ) : null;
  }

  return (
    <div
      className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100"
      role="alert"
    >
      <span>
        config.yaml changed after the dashboard loaded it
        {conflict.currentRevision === null
          ? ""
          : ` (now ${conflict.currentRevision})`}
        . Your change ({conflict.change.kind}) is not saved.
      </span>
      <span className="flex gap-2">
        <ActionButton
          onClick={async () => {
            await config.resolveConflict("reload");
          }}
        >
          Reload and discard my change
        </ActionButton>
        <ActionButton
          onClick={async () => {
            await config.resolveConflict("overwrite");
          }}
          tone="primary"
        >
          Apply my change to the new version
        </ActionButton>
      </span>
    </div>
  );
};

/** Creates an Agent after the Operator confirms its name and model. */
export const CreateAgentButton = () => {
  const { config } = useServices();
  const { config: deploymentConfig } = useStore(config.state);
  const save = useSaveOrThrow();
  const navigate = useNavigate();
  const providersId = useId();
  const modelsId = useId();
  const [name, setName] = useState("");
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const providers = Object.keys(deploymentConfig?.provider ?? {});

  return (
    <ConfirmButton
      confirmLabel="Create Agent"
      description="Wheatley adds the Agent to config.yaml. The other Agents keep running."
      label="Create Agent"
      onConfirm={async () => {
        if (!isAgentName(name)) {
          throw new Error(
            `"${name}" is not a valid Agent name. ${AGENT_NAME_HINT}`
          );
        }

        if (provider === "" || model === "") {
          throw new Error("Enter a provider and a model ID.");
        }

        await save({
          agent: name,
          config: { model: `${provider}/${model}` },
          kind: "create",
        });
        setName("");
        await navigate({
          params: { agent: name },
          to: "/agents/$agent/config",
        });
      }}
      title="Create an Agent"
      tone="primary"
    >
      <div className="space-y-3">
        <Field hint={AGENT_NAME_HINT} label="Name">
          <input
            className={inputClass}
            onChange={(event) => {
              setName(event.target.value);
            }}
            value={name}
          />
        </Field>
        <Field label="Provider">
          <input
            className={inputClass}
            list={providersId}
            onChange={(event) => {
              setProvider(event.target.value);
            }}
            value={provider}
          />
        </Field>
        <Field label="Model ID">
          <input
            className={inputClass}
            list={modelsId}
            onChange={(event) => {
              setModel(event.target.value);
            }}
            value={model}
          />
        </Field>
        <ModelSuggestions
          extraProviders={providers}
          modelsId={modelsId}
          provider={provider}
          providersId={providersId}
        />
      </div>
    </ConfirmButton>
  );
};

/** Renames an Agent after the Operator confirms the new name. */
export const RenameAgentButton = ({ agent }: { readonly agent: string }) => {
  const save = useSaveOrThrow();
  const navigate = useNavigate();
  const [newName, setNewName] = useState(agent);

  return (
    <ConfirmButton
      confirmLabel="Rename"
      description={`Wheatley renames ${agent} in config.yaml.`}
      label="Rename"
      onConfirm={async () => {
        if (!isAgentName(newName) || newName === agent) {
          throw new Error(`Enter a new valid name. ${AGENT_NAME_HINT}`);
        }

        await save({ agent, kind: "rename", newName });
        await navigate({
          params: { agent: newName },
          to: "/agents/$agent/config",
        });
      }}
      title={`Rename ${agent}`}
      tone="primary"
    >
      <Field hint={AGENT_NAME_HINT} label="New name">
        <input
          className={inputClass}
          onChange={(event) => {
            setNewName(event.target.value);
          }}
          value={newName}
        />
      </Field>
    </ConfirmButton>
  );
};

const DISPOSALS: readonly { value: AgentDataDisposal; label: string }[] = [
  { label: "Keep the folder", value: "keep" },
  { label: "Move the folder to the archive", value: "archive" },
  { label: "Delete the folder and all its data", value: "delete" },
];

/** Deletes an Agent after the Operator confirms what happens to its data. */
export const DeleteAgentButton = ({ agent }: { readonly agent: string }) => {
  const save = useSaveOrThrow();
  const navigate = useNavigate();
  const [data, setData] = useState<AgentDataDisposal>("archive");

  return (
    <ConfirmButton
      confirmLabel={`Delete ${agent}`}
      description={`Wheatley removes ${agent} from config.yaml. Choose what happens to its folder, which holds its Conversations, Memory, and Triggers.`}
      label="Delete"
      onConfirm={async () => {
        await save({ agent, data, kind: "delete" });
        await navigate({ to: "/overview" });
      }}
      title={`Delete ${agent}?`}
    >
      <fieldset className="space-y-1 text-sm">
        <legend className="mb-1 font-medium">agents/{agent}/</legend>
        {DISPOSALS.map((option) => (
          <label className="flex items-center gap-2" key={option.value}>
            <input
              checked={data === option.value}
              name={`dispose-${agent}`}
              onChange={() => {
                setData(option.value);
              }}
              type="radio"
            />
            {option.label}
          </label>
        ))}
      </fieldset>
    </ConfirmButton>
  );
};
