import { Button } from "@ui-sdk/react/button";
import { SecretNameSchema, decode } from "@wheatley-ai/protocol";
import type { SecretInfo } from "@wheatley-ai/protocol";
import { useState } from "react";

import { useServices, useStore } from "../hooks.js";
import { MASKED_VALUE } from "../models/secrets.js";
import { errorMessage } from "../store.js";
import {
  ActionButton,
  Badge,
  buttonClass,
  ConfirmButton,
  Empty,
  ErrorText,
  Field,
  inputClass,
  PageHeader,
  Panel,
} from "./ui.js";

const SOURCE_LABELS: Record<SecretInfo["source"], string> = {
  both: "secrets.yaml and environment",
  env: "environment",
  file: "secrets.yaml",
};

const SetSecretForm = ({
  fixedName,
  onDone,
}: {
  readonly fixedName?: string;
  readonly onDone?: () => void;
}) => {
  const { secrets } = useServices();
  const [name, setName] = useState(fixedName ?? "");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    if (!decode(SecretNameSchema, name).ok) {
      setError(
        "A secret name has letters, digits, and underscores, and does not start with a digit."
      );

      return;
    }

    if (value === "") {
      setError("Enter a value.");

      return;
    }

    try {
      await secrets.set(name, value);
      setValue("");
      setError(null);

      if (fixedName === undefined) {
        setName("");
      }

      onDone?.();
    } catch (error_) {
      setError(errorMessage(error_));
    }
  };

  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {fixedName === undefined ? (
        <Field label="Name">
          <input
            autoComplete="off"
            className={inputClass}
            onChange={(event) => {
              setName(event.target.value);
            }}
            value={name}
          />
        </Field>
      ) : null}
      <Field
        label={fixedName === undefined ? "Value" : `New value of ${fixedName}`}
      >
        <input
          autoComplete="new-password"
          className={inputClass}
          onChange={(event) => {
            setValue(event.target.value);
          }}
          type="password"
          value={value}
        />
      </Field>
      <ActionButton onClick={submit} tone="primary">
        {fixedName === undefined ? "Add secret" : "Rotate"}
      </ActionButton>
      <div className="w-full">
        <ErrorText error={error} />
      </div>
    </form>
  );
};

const SecretRow = ({ secret }: { readonly secret: SecretInfo }) => {
  const { secrets } = useServices();
  const { busy, itemErrors, revealed } = useStore(secrets.state);
  const [rotating, setRotating] = useState(false);
  const value = revealed.get(secret.name);

  return (
    <li className="space-y-2 rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono font-semibold">{secret.name}</span>
        <Badge color="zinc">{SOURCE_LABELS[secret.source]}</Badge>
        {secret.references.map((reference) => (
          <Badge
            color="indigo"
            key={`${reference.agent ?? ""}:${reference.kind}:${reference.id}`}
          >
            {reference.agent === undefined ? "" : `${reference.agent} · `}
            {reference.kind} {reference.id}
          </Badge>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <code className="rounded bg-zinc-100 px-2 py-1 text-sm break-all dark:bg-zinc-950">
          {value ?? MASKED_VALUE}
        </code>
        {value === undefined ? (
          <ActionButton
            disabled={busy.has(secret.name)}
            onClick={async () => {
              await secrets.reveal(secret.name);
            }}
          >
            Reveal
          </ActionButton>
        ) : (
          <Button
            className={buttonClass()}
            onClick={() => {
              secrets.hide(secret.name);
            }}
          >
            Hide
          </Button>
        )}
        <Button
          className={buttonClass()}
          onClick={() => {
            setRotating((current) => !current);
          }}
        >
          {rotating ? "Cancel rotation" : "Rotate"}
        </Button>
        <ConfirmButton
          confirmLabel="Delete secret"
          description={
            secret.references.length === 0
              ? "No config entry refers to this secret."
              : `${secret.references.length} config entries refer to this secret. They fail until you add it again.`
          }
          label="Delete"
          onConfirm={async () => {
            await secrets.remove(secret.name);
          }}
          title={`Delete ${secret.name}?`}
        />
      </div>
      {rotating ? (
        <SetSecretForm
          fixedName={secret.name}
          onDone={() => {
            setRotating(false);
          }}
        />
      ) : null}
      <ErrorText error={itemErrors.get(secret.name) ?? null} />
    </li>
  );
};

/** The Secrets view: masked secret names, on-demand `secrets.reveal`, rotation, and deletion. */
export const SecretsView = () => {
  const { secrets } = useServices();
  const { error, loading, secrets: list } = useStore(secrets.state);

  return (
    <div className="space-y-4">
      <PageHeader
        subtitle="Values stay hidden until you reveal one. A revealed value stays in this tab only."
        title="Secrets"
      />
      <ErrorText error={error} />
      <Panel title="Add a secret">
        <SetSecretForm />
      </Panel>
      <Panel title={`Secrets (${list.length})`}>
        {list.length === 0 ? (
          <Empty>{loading ? "Loading…" : "No secrets."}</Empty>
        ) : (
          <ul className="space-y-3">
            {list.map((secret) => (
              <SecretRow key={secret.name} secret={secret} />
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
};
