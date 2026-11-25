import { Button } from "@ui-sdk/react/button";
import {
  ConversationModeSchema,
  TriggerInputSchema,
  decode,
} from "@wheatley-ai/protocol";
import type {
  ConversationMode,
  PermissionAction,
  Trigger,
  TriggerInput,
  TriggerSchedule,
} from "@wheatley-ai/protocol";
import { useState } from "react";

import { useRpcQuery, useServices, useStore } from "../hooks.js";
import { errorMessage } from "../store.js";
import {
  ActionButton,
  Badge,
  buttonClass,
  ConfirmButton,
  Empty,
  ErrorText,
  Field,
  formatTime,
  inputClass,
  PageHeader,
  Panel,
  StateBadge,
} from "./ui.js";
import type { BadgeColor } from "./ui.js";

type ScheduleKind = TriggerSchedule["kind"];

const ACTION_COLORS: Record<PermissionAction, BadgeColor> = {
  allow: "green",
  ask: "amber",
  deny: "red",
};

const SCHEDULE_KINDS: readonly ScheduleKind[] = ["cron", "once", "webhook"];

const isScheduleKind = (value: string): value is ScheduleKind =>
  SCHEDULE_KINDS.some((kind) => kind === value);

/** The fields of the Trigger form, as text. */
interface TriggerFields {
  readonly name: string;
  readonly prompt: string;
  readonly conversationMode: ConversationMode;
  readonly paused: boolean;
  readonly kind: ScheduleKind;
  readonly cron: string;
  readonly timezone: string;
  /** A `datetime-local` value in the browser's time zone. */
  readonly at: string;
  readonly tokenSecret: string;
  readonly bindingId: string;
  readonly chatId: string;
}

const LOCAL_DATETIME_LENGTH = 16;

const toLocalInput = (timestamp: string): string => {
  const date = new Date(timestamp);
  const offsetMs = date.getTimezoneOffset() * 60_000;

  return new Date(date.getTime() - offsetMs)
    .toISOString()
    .slice(0, LOCAL_DATETIME_LENGTH);
};

const browserTimezone = (): string =>
  Intl.DateTimeFormat().resolvedOptions().timeZone;

const emptyFields = (): TriggerFields => ({
  at: "",
  bindingId: "cli",
  chatId: "default",
  conversationMode: "per_firing",
  cron: "0 9 * * *",
  kind: "cron",
  name: "",
  paused: false,
  prompt: "",
  timezone: browserTimezone(),
  tokenSecret: "",
});

const fieldsOf = (trigger: Trigger): TriggerFields => ({
  ...emptyFields(),
  at: trigger.schedule.kind === "once" ? toLocalInput(trigger.schedule.at) : "",
  bindingId: trigger.target.bindingId,
  chatId: trigger.target.chatId,
  conversationMode: trigger.conversationMode,
  cron: trigger.schedule.kind === "cron" ? trigger.schedule.schedule : "",
  kind: trigger.schedule.kind,
  name: trigger.name,
  paused: trigger.paused,
  prompt: trigger.prompt,
  timezone:
    trigger.schedule.kind === "cron"
      ? trigger.schedule.timezone
      : browserTimezone(),
  tokenSecret:
    trigger.schedule.kind === "webhook" ? trigger.schedule.tokenSecret : "",
});

const scheduleOf = (fields: TriggerFields): TriggerSchedule => {
  if (fields.kind === "cron") {
    return {
      kind: "cron",
      schedule: fields.cron.trim(),
      timezone: fields.timezone.trim(),
    };
  }

  if (fields.kind === "once") {
    const at = new Date(fields.at);

    if (Number.isNaN(at.getTime())) {
      throw new TypeError("Enter a date and time for the firing.");
    }

    return { at: at.toISOString(), kind: "once" };
  }

  return { kind: "webhook", tokenSecret: fields.tokenSecret.trim() };
};

/** Builds a validated Trigger from the form. Throws an Error that names the first invalid field. */
const toTriggerInput = (fields: TriggerFields): TriggerInput => {
  const candidate: TriggerInput = {
    conversationMode: fields.conversationMode,
    name: fields.name.trim(),
    paused: fields.paused,
    prompt: fields.prompt,
    schedule: scheduleOf(fields),
    target: {
      bindingId: fields.bindingId.trim(),
      chatId: fields.chatId.trim(),
    },
  };

  const decoded = decode(TriggerInputSchema, candidate);

  if (!decoded.ok) {
    const [issue] = decoded.issues;

    throw new TypeError(
      issue === undefined
        ? "The Trigger is invalid."
        : `${issue.path}: ${issue.message}`
    );
  }

  return decoded.value;
};

const TriggerForm = ({
  bindings,
  initial,
  onSubmit,
  submitLabel,
}: {
  readonly bindings: readonly string[];
  readonly initial: TriggerFields;
  readonly submitLabel: string;
  readonly onSubmit: (input: TriggerInput) => Promise<void>;
}) => {
  const [fields, setFields] = useState(initial);
  const [error, setError] = useState<string | null>(null);

  const set = <Key extends keyof TriggerFields>(
    key: Key,
    value: TriggerFields[Key]
  ): void => {
    setFields((current) => ({ ...current, [key]: value }));
  };

  return (
    <form
      className="grid gap-3 sm:grid-cols-2"
      onSubmit={(event) => {
        event.preventDefault();
      }}
    >
      <Field label="Name">
        <input
          className={inputClass}
          onChange={(event) => {
            set("name", event.target.value);
          }}
          value={fields.name}
        />
      </Field>
      <Field label="Conversation">
        <select
          className={inputClass}
          onChange={(event) => {
            const decoded = decode(ConversationModeSchema, event.target.value);

            if (decoded.ok) {
              set("conversationMode", decoded.value);
            }
          }}
          value={fields.conversationMode}
        >
          <option value="per_firing">A new Conversation for each firing</option>
          <option value="shared">One Conversation for all firings</option>
        </select>
      </Field>
      <div className="sm:col-span-2">
        <Field hint="A webhook firing appends the request body." label="Prompt">
          <textarea
            className={`${inputClass} min-h-20`}
            onChange={(event) => {
              set("prompt", event.target.value);
            }}
            value={fields.prompt}
          />
        </Field>
      </div>
      <Field label="Schedule">
        <select
          className={inputClass}
          onChange={(event) => {
            if (isScheduleKind(event.target.value)) {
              set("kind", event.target.value);
            }
          }}
          value={fields.kind}
        >
          <option value="cron">Cron expression</option>
          <option value="once">Once</option>
          <option value="webhook">Webhook</option>
        </select>
      </Field>
      {fields.kind === "cron" ? (
        <>
          <Field
            hint="5 fields: minute hour day month weekday"
            label="Cron expression"
          >
            <input
              className={`${inputClass} font-mono`}
              onChange={(event) => {
                set("cron", event.target.value);
              }}
              value={fields.cron}
            />
          </Field>
          <Field label="Time zone">
            <input
              className={inputClass}
              onChange={(event) => {
                set("timezone", event.target.value);
              }}
              value={fields.timezone}
            />
          </Field>
        </>
      ) : null}
      {fields.kind === "once" ? (
        <Field label="Fire at">
          <input
            className={inputClass}
            onChange={(event) => {
              set("at", event.target.value);
            }}
            type="datetime-local"
            value={fields.at}
          />
        </Field>
      ) : null}
      {fields.kind === "webhook" ? (
        <Field
          hint="The secret in secrets.yaml that holds the Bearer token."
          label="Token secret"
        >
          <input
            className={`${inputClass} font-mono`}
            onChange={(event) => {
              set("tokenSecret", event.target.value);
            }}
            value={fields.tokenSecret}
          />
        </Field>
      ) : null}
      <Field label="Target Frontend Binding">
        <select
          className={inputClass}
          onChange={(event) => {
            set("bindingId", event.target.value);
          }}
          value={fields.bindingId}
        >
          {[...new Set(["cli", ...bindings, fields.bindingId])].map(
            (binding) => (
              <option key={binding} value={binding}>
                {binding}
              </option>
            )
          )}
        </select>
      </Field>
      <Field label="Target Chat ID">
        <input
          className={inputClass}
          onChange={(event) => {
            set("chatId", event.target.value);
          }}
          value={fields.chatId}
        />
      </Field>
      <label className="flex items-center gap-2 text-sm">
        <input
          checked={fields.paused}
          onChange={(event) => {
            set("paused", event.target.checked);
          }}
          type="checkbox"
        />
        Paused
      </label>
      <div className="flex items-center justify-end gap-2 sm:col-span-2">
        <ActionButton
          onClick={async () => {
            setError(null);

            try {
              await onSubmit(toTriggerInput(fields));
            } catch (error_) {
              setError(errorMessage(error_));
            }
          }}
          tone="primary"
        >
          {submitLabel}
        </ActionButton>
      </div>
      <div className="sm:col-span-2">
        <ErrorText error={error} />
      </div>
    </form>
  );
};

const describeSchedule = (schedule: TriggerSchedule): string => {
  if (schedule.kind === "cron") {
    return `${schedule.schedule} (${schedule.timezone})`;
  }

  if (schedule.kind === "once") {
    return `once at ${formatTime(schedule.at)}`;
  }

  return `webhook, token ${schedule.tokenSecret}`;
};

const TriggerRow = ({
  agent,
  bindings,
  trigger,
}: {
  readonly agent: string;
  readonly bindings: readonly string[];
  readonly trigger: Trigger;
}) => {
  const { client } = useServices();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const act = async (action: () => Promise<void>): Promise<void> => {
    setError(null);

    try {
      await action();
    } catch (error_) {
      setError(errorMessage(error_));
    }
  };

  return (
    <li className="space-y-2 rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-semibold">{trigger.name}</span>
        {trigger.paused ? (
          <Badge color="zinc">paused</Badge>
        ) : (
          <Badge color="green">active</Badge>
        )}
        <Badge color="indigo">by {trigger.createdBy}</Badge>
        <span className="font-mono text-xs">
          {describeSchedule(trigger.schedule)}
        </span>
      </div>
      <p className="text-sm whitespace-pre-wrap text-zinc-600 dark:text-zinc-400">
        {trigger.prompt}
      </p>
      <p className="text-xs text-zinc-500">
        Target {trigger.target.bindingId} / {trigger.target.chatId} · last fired{" "}
        {formatTime(trigger.lastFiredAt)} · next{" "}
        {formatTime(trigger.nextFireAt)}
      </p>
      <div className="flex flex-wrap gap-2">
        <ActionButton
          onClick={async () => {
            await act(async () => {
              await client.call("triggers.fire", {
                agent,
                triggerId: trigger.id,
              });
            });
          }}
          tone="primary"
        >
          Fire now
        </ActionButton>
        <ActionButton
          onClick={async () => {
            await act(async () => {
              await client.call("triggers.update", {
                agent,
                patch: { paused: !trigger.paused },
                triggerId: trigger.id,
              });
            });
          }}
        >
          {trigger.paused ? "Resume" : "Pause"}
        </ActionButton>
        <Button
          className={buttonClass()}
          onClick={() => {
            setEditing((current) => !current);
          }}
        >
          {editing ? "Cancel edit" : "Edit"}
        </Button>
        <ConfirmButton
          confirmLabel="Delete Trigger"
          description="The Trigger stops firing. Its past Runs stay."
          label="Delete"
          onConfirm={async () => {
            await client.call("triggers.delete", {
              agent,
              triggerId: trigger.id,
            });
          }}
          title={`Delete ${trigger.name}?`}
        />
      </div>
      {editing ? (
        <TriggerForm
          bindings={bindings}
          initial={fieldsOf(trigger)}
          onSubmit={async (input) => {
            await client.call("triggers.update", {
              agent,
              patch: input,
              triggerId: trigger.id,
            });
            setEditing(false);
          }}
          submitLabel="Save Trigger"
        />
      ) : null}
      <ErrorText error={error} />
    </li>
  );
};

const ExtensionsPanel = ({ agent }: { readonly agent: string }) => {
  const extensions = useRpcQuery(
    "extensions.list",
    { agent },
    { agent, refreshOn: ["agent.status", "config.changed"] }
  );

  const { data } = extensions;

  return (
    <Panel title="Extensions">
      <ErrorText error={extensions.error} />
      {data === null ? (
        <Empty>Loading…</Empty>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <h3 className="mb-1 text-sm font-semibold">Frontend Bindings</h3>
            <ul className="space-y-1 text-sm">
              {data.frontends.map((binding) => (
                <li className="flex items-center gap-2" key={binding.id}>
                  <span className="font-mono">{binding.id}</span>
                  <span className="text-zinc-500">{binding.type}</span>
                  <StateBadge state={binding.state} />
                  {binding.error === undefined ? null : (
                    <span className="text-xs text-red-600">
                      {binding.error}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="mb-1 text-sm font-semibold">
              Plugins and MCP Servers
            </h3>
            <ul className="space-y-1 text-sm">
              {[...data.plugins, ...data.mcpServers].map((extension) => (
                <li className="flex items-center gap-2" key={extension.name}>
                  <span className="font-mono">{extension.name}</span>
                  <StateBadge state={extension.state} />
                  {extension.error === undefined ? null : (
                    <span className="text-xs text-red-600">
                      {extension.error}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="mb-1 text-sm font-semibold">Skills</h3>
            <ul className="space-y-1 text-sm">
              {data.skills.map((skill) => (
                <li key={`${skill.origin}:${skill.name}`}>
                  <span className="font-mono">{skill.name}</span>{" "}
                  <Badge color="zinc">{skill.origin}</Badge>{" "}
                  <span className="text-zinc-500">{skill.description}</span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="mb-1 text-sm font-semibold">
              Tools and Permission Policy
            </h3>
            <ul className="space-y-1 text-sm">
              {data.tools.map((tool) => (
                <li
                  className="flex flex-wrap items-center gap-2"
                  key={tool.name}
                >
                  <span className="font-mono">{tool.name}</span>
                  <Badge color={ACTION_COLORS[tool.action]}>
                    {tool.action}
                  </Badge>
                  <span className="text-zinc-500">{tool.source}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </Panel>
  );
};

/** The Triggers and Extensions view of one Agent. */
export const TriggersView = ({ agent }: { readonly agent: string }) => {
  const { client, config } = useServices();
  const { config: deploymentConfig } = useStore(config.state);

  const triggers = useRpcQuery(
    "triggers.list",
    { agent },
    { agent, refreshOn: ["trigger.changed"] }
  );

  const [creating, setCreating] = useState(false);

  const bindings = (deploymentConfig?.agents[agent]?.frontends ?? []).map(
    (binding) => binding.id
  );

  return (
    <div className="space-y-4">
      <PageHeader
        actions={
          <Button
            className={buttonClass("primary")}
            onClick={() => {
              setCreating((current) => !current);
            }}
          >
            {creating ? "Cancel" : "New Trigger"}
          </Button>
        }
        title={`Triggers and Extensions · ${agent}`}
      />
      {creating ? (
        <Panel title="New Trigger">
          <TriggerForm
            bindings={bindings}
            initial={emptyFields()}
            onSubmit={async (input) => {
              await client.call("triggers.create", { agent, trigger: input });
              setCreating(false);
            }}
            submitLabel="Create Trigger"
          />
        </Panel>
      ) : null}
      <Panel title="Triggers">
        <ErrorText error={triggers.error} />
        {(triggers.data?.triggers ?? []).length === 0 ? (
          <Empty>{triggers.loading ? "Loading…" : "No Triggers."}</Empty>
        ) : (
          <ul className="space-y-3">
            {(triggers.data?.triggers ?? []).map((trigger) => (
              <TriggerRow
                agent={agent}
                bindings={bindings}
                key={trigger.id}
                trigger={trigger}
              />
            ))}
          </ul>
        )}
      </Panel>
      <ExtensionsPanel agent={agent} />
    </div>
  );
};
