import { Button } from "@ui-sdk/react/button";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@ui-sdk/react/tabs";
import {
  AgentConfigSchema,
  PermissionActionSchema,
  decode,
  isJsonValue,
  parseModelId,
} from "@wheatley-ai/protocol";
import type {
  AgentConfig,
  ConfigIssue,
  PendingRestart,
  PermissionAction,
  PermissionRule,
} from "@wheatley-ai/protocol";
import { useEffect, useId, useState } from "react";

import { useServices, useStore } from "../hooks.js";
import {
  DEFAULT_MEMORY_MAX_CHARS,
  isDraftDirty,
  pendingRestartsOf,
} from "../models/config-editor.js";
import type { RestartMode } from "../models/config-editor.js";
import { DeleteAgentButton, RenameAgentButton } from "./agent-admin.js";
import { ModelSuggestions } from "./model-picker.js";
import {
  ActionButton,
  Badge,
  buttonClass,
  Empty,
  ErrorText,
  Field,
  inputClass,
  Notice,
  PageHeader,
  Panel,
} from "./ui.js";

type OptionalKey = Exclude<keyof AgentConfig, "model">;

/** Returns a copy of `config` with `key` set, or without `key` for `undefined`. */
const withOptional = <Key extends OptionalKey>(
  config: AgentConfig,
  key: Key,
  value: AgentConfig[Key] | undefined
): AgentConfig => {
  const next: AgentConfig = { ...config };

  if (value === undefined) {
    // oxlint-disable-next-line typescript/no-dynamic-delete -- `Key` is limited to the optional fields of AgentConfig.
    delete next[key];
  } else {
    next[key] = value;
  }

  return next;
};

/** Parses a positive integer field. An empty field means "use the default". */
const parseCount = (text: string): number | undefined => {
  const trimmed = text.trim();

  if (trimmed === "") {
    return undefined;
  }

  const value = Number(trimmed);

  return Number.isInteger(value) && value > 0 ? value : undefined;
};

const describePending = (entry: PendingRestart): string => {
  if (entry.kind === "agent") {
    return `Agent ${entry.agent}`;
  }

  if (entry.kind === "binding") {
    return `Frontend Binding ${entry.bindingId} of ${entry.agent}`;
  }

  return `Daemon: ${entry.reason}`;
};

const IssueList = ({ issues }: { readonly issues: readonly ConfigIssue[] }) =>
  issues.length === 0 ? null : (
    <ul className="space-y-1 rounded-md bg-red-50 p-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
      {issues.map((issue) => (
        <li key={`${issue.path}:${issue.message}`}>
          <span className="font-mono">{issue.path}</span>: {issue.message}
        </li>
      ))}
    </ul>
  );

const SaveButtons = ({
  disabled,
  onSave,
}: {
  readonly disabled: boolean;
  readonly onSave: (restart: RestartMode) => Promise<void>;
}) => (
  <>
    <ActionButton
      disabled={disabled}
      onClick={async () => {
        await onSave("none");
      }}
    >
      Save
    </ActionButton>
    <ActionButton
      disabled={disabled}
      onClick={async () => {
        await onSave("affected");
      }}
      tone="primary"
    >
      Save & Restart
    </ActionButton>
  </>
);

/** Shows the changes of this Agent that wait for a restart, and restarts it. */
const PendingRestartBar = ({ agent }: { readonly agent: string }) => {
  const { config } = useServices();
  const state = useStore(config.state);
  const own = pendingRestartsOf(state, agent);

  const daemon = state.pendingRestart.filter(
    (entry) => entry.kind === "daemon"
  );

  if (own.length === 0 && daemon.length === 0) {
    return null;
  }

  return (
    <div
      className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100"
      role="status"
    >
      <span>
        Saved changes wait for a restart:{" "}
        {[...own, ...daemon].map(describePending).join(", ")}.
      </span>
      {own.length === 0 ? null : (
        <ActionButton
          onClick={async () => {
            await config.restartAgent(agent);
          }}
          tone="primary"
        >
          Restart {agent}
        </ActionButton>
      )}
    </div>
  );
};

const PolicyEditor = ({
  onChange,
  rules,
}: {
  readonly rules: readonly PermissionRule[];
  readonly onChange: (rules: PermissionRule[]) => void;
}) => {
  const replace = (index: number, rule: PermissionRule): void => {
    onChange(
      rules.map((entry, position) => (position === index ? rule : entry))
    );
  };

  const move = (index: number, offset: number): void => {
    const target = index + offset;
    const rule = rules[index];

    if (rule === undefined || target < 0 || target >= rules.length) {
      return;
    }

    const next = rules.filter((_entry, position) => position !== index);

    next.splice(target, 0, rule);
    onChange(next);
  };

  return (
    <div className="space-y-2">
      <p className="text-xs text-zinc-500">
        Rules apply in order. The first rule that matches a Tool wins. Use * as
        a wildcard, for example mcp:github:*.
      </p>
      {rules.map((rule, index) => (
        // Rules have no IDs. The index is the rule's identity, because order is its meaning.
        <div className="flex flex-wrap items-center gap-2" key={index}>
          <input
            aria-label={`Tool pattern of rule ${index + 1}`}
            className={`${inputClass} max-w-xs font-mono`}
            onChange={(event) => {
              replace(index, { ...rule, tool: event.target.value });
            }}
            value={rule.tool}
          />
          <select
            aria-label={`Action of rule ${index + 1}`}
            className={`${inputClass} max-w-28`}
            onChange={(event) => {
              const action = decode(PermissionActionSchema, event.target.value);

              if (action.ok) {
                replace(index, { ...rule, action: action.value });
              }
            }}
            value={rule.action}
          >
            {(["allow", "ask", "deny"] satisfies PermissionAction[]).map(
              (action) => (
                <option key={action} value={action}>
                  {action}
                </option>
              )
            )}
          </select>
          <button
            aria-label={`Move rule ${index + 1} up`}
            className="px-1 text-sm"
            onClick={() => {
              move(index, -1);
            }}
            type="button"
          >
            ↑
          </button>
          <button
            aria-label={`Move rule ${index + 1} down`}
            className="px-1 text-sm"
            onClick={() => {
              move(index, 1);
            }}
            type="button"
          >
            ↓
          </button>
          <button
            className="text-sm text-red-600"
            onClick={() => {
              onChange(rules.filter((_entry, position) => position !== index));
            }}
            type="button"
          >
            Remove
          </button>
        </div>
      ))}
      <button
        className="text-sm text-indigo-600"
        onClick={() => {
          onChange([...rules, { action: "ask", tool: "" }]);
        }}
        type="button"
      >
        Add rule
      </button>
    </div>
  );
};

/** The structured form of one Agent's settings. */
const AgentSettings = ({
  agent,
  source,
}: {
  readonly agent: string;
  readonly source: AgentConfig;
}) => {
  const { config } = useServices();
  const { saving } = useStore(config.state);
  const [draft, setDraft] = useState<AgentConfig | null>(null);
  const [issues, setIssues] = useState<readonly ConfigIssue[]>([]);
  const providersId = useId();
  const modelsId = useId();
  const current = draft ?? source;
  const memory = current.memory ?? {};

  useEffect(() => {
    setDraft(null);
    setIssues([]);
  }, [agent]);

  const edit = (next: AgentConfig): void => {
    setDraft(next);
  };

  const save = async (restart: RestartMode): Promise<void> => {
    // The daemon receives the config as JSON, so validate the JSON form, without undefined fields.
    // oxlint-disable-next-line unicorn/prefer-structured-clone -- structuredClone keeps undefined fields.
    const wire: unknown = JSON.parse(JSON.stringify(current));

    if (!isJsonValue(wire)) {
      setIssues([
        {
          message: "The settings hold values that JSON cannot carry.",
          path: "/",
        },
      ]);

      return;
    }

    const decoded = decode(AgentConfigSchema, wire);

    if (!decoded.ok) {
      setIssues(decoded.issues);

      return;
    }

    setIssues([]);

    if (
      await config.save({
        agent,
        config: decoded.value,
        kind: "agent",
        restart,
      })
    ) {
      setDraft(null);
    }
  };

  const currentModel = parseModelId(current.model);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Provider">
          <input
            className={inputClass}
            list={providersId}
            onChange={(event) => {
              edit({
                ...current,
                model: `${event.target.value}/${currentModel.id}`,
              });
            }}
            value={currentModel.provider}
          />
        </Field>
        <Field label="Model ID">
          <input
            className={inputClass}
            list={modelsId}
            onChange={(event) => {
              edit({
                ...current,
                model: `${currentModel.provider}/${event.target.value}`,
              });
            }}
            value={currentModel.id}
          />
        </Field>
        <ModelSuggestions
          modelsId={modelsId}
          provider={currentModel.provider}
          providersId={providersId}
        />
        <Field label="Thinking">
          <select
            className={inputClass}
            onChange={(event) => {
              const { value } = event.target;

              edit(
                withOptional(
                  current,
                  "thinking",
                  value === "off" ||
                    value === "low" ||
                    value === "medium" ||
                    value === "high"
                    ? value
                    : undefined
                )
              );
            }}
            value={current.thinking ?? ""}
          >
            <option value="">Provider default</option>
            <option value="off">off</option>
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
          </select>
        </Field>
      </div>
      <Field label="Instructions">
        <textarea
          className={`${inputClass} min-h-28`}
          onChange={(event) => {
            const { value } = event.target;

            edit(
              withOptional(
                current,
                "instructions",
                value === "" ? undefined : value
              )
            );
          }}
          value={current.instructions ?? ""}
        />
      </Field>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field hint="For example 15m. Empty uses 15m." label="Approval timeout">
          <input
            className={inputClass}
            disabled={current.approvalTimeout === null}
            onChange={(event) => {
              const { value } = event.target;

              edit(
                withOptional(
                  current,
                  "approvalTimeout",
                  value === "" ? undefined : value
                )
              );
            }}
            value={current.approvalTimeout ?? ""}
          />
          <label className="mt-1 flex items-center gap-2 text-xs">
            <input
              checked={current.approvalTimeout === null}
              onChange={(event) => {
                edit(
                  withOptional(
                    current,
                    "approvalTimeout",
                    event.target.checked ? null : undefined
                  )
                );
              }}
              type="checkbox"
            />
            Approvals never time out
          </label>
        </Field>
        <Field hint="Empty uses the default." label="Concurrent Runs">
          <input
            className={inputClass}
            min={1}
            onChange={(event) => {
              edit(
                withOptional(
                  current,
                  "maxConcurrentRuns",
                  parseCount(event.target.value)
                )
              );
            }}
            type="number"
            value={current.maxConcurrentRuns ?? ""}
          />
        </Field>
        <Field
          hint={`Empty uses ${DEFAULT_MEMORY_MAX_CHARS.toLocaleString("en-US")}.`}
          label="MEMORY.md character cap"
        >
          <input
            className={inputClass}
            min={1}
            onChange={(event) => {
              const maxChars = parseCount(event.target.value);
              const { maxChars: _previous, ...rest } = memory;

              edit(
                withOptional(
                  current,
                  "memory",
                  maxChars === undefined ? rest : { ...rest, maxChars }
                )
              );
            }}
            type="number"
            value={memory.maxChars ?? ""}
          />
        </Field>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          checked={memory.consolidation?.enabled ?? false}
          onChange={(event) => {
            edit(
              withOptional(current, "memory", {
                ...memory,
                consolidation: {
                  ...memory.consolidation,
                  enabled: event.target.checked,
                },
              })
            );
          }}
          type="checkbox"
        />
        Consolidate Memory on a schedule
      </label>
      <Panel title="Permission Policy">
        <PolicyEditor
          onChange={(rules) => {
            edit(withOptional(current, "permissionPolicy", rules));
          }}
          rules={current.permissionPolicy ?? []}
        />
      </Panel>
      <p className="text-xs text-zinc-500">
        Edit Frontend Bindings, Plugins, MCP Servers, and Skills in the raw YAML
        editor. This form keeps them as they are.
      </p>
      <IssueList issues={issues} />
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          className={buttonClass()}
          disabled={draft === null}
          onClick={() => {
            setDraft(null);
            setIssues([]);
          }}
        >
          Discard changes
        </Button>
        <SaveButtons disabled={draft === null || saving} onSave={save} />
      </div>
    </div>
  );
};

/** The raw YAML editor of the whole `config.yaml`. */
const RawEditor = () => {
  const { config } = useServices();
  const state = useStore(config.state);
  const dirty = isDraftDirty(state);
  const [validMessage, setValidMessage] = useState<string | null>(null);

  return (
    <div className="space-y-3">
      <p className="text-xs text-zinc-500">
        The whole config.yaml of the Deployment, revision{" "}
        {state.revision ?? "–"}. Secret values belong in Secrets.
      </p>
      <textarea
        aria-label="config.yaml"
        className={`${inputClass} min-h-[50vh] font-mono text-xs`}
        onChange={(event) => {
          setValidMessage(null);
          config.setDraft(event.target.value);
        }}
        spellCheck={false}
        value={state.draft}
      />
      <IssueList issues={state.issues} />
      {validMessage === null ? null : <Notice>{validMessage}</Notice>}
      <div className="flex flex-wrap justify-end gap-2">
        <ActionButton
          disabled={!dirty}
          onClick={async () => {
            setValidMessage(null);
            await config.load();
          }}
        >
          Discard edits
        </ActionButton>
        <ActionButton
          onClick={async () => {
            setValidMessage(
              (await config.validate()) ? "The draft is valid." : null
            );
          }}
        >
          Validate
        </ActionButton>
        <SaveButtons
          disabled={!dirty || state.saving}
          onSave={async (restart) => {
            setValidMessage(null);
            await config.save({ kind: "raw", raw: state.draft, restart });
          }}
        />
      </div>
    </div>
  );
};

/** The Config view: structured settings of one Agent, the raw YAML editor, restarts, and Agent rename and delete. */
export const ConfigView = ({ agent }: { readonly agent: string }) => {
  const { config } = useServices();
  const state = useStore(config.state);
  const source = state.config?.agents[agent];

  return (
    <div className="space-y-4">
      <PageHeader
        actions={
          source === undefined ? undefined : (
            <>
              <RenameAgentButton agent={agent} />
              <DeleteAgentButton agent={agent} />
            </>
          )
        }
        subtitle={
          <>
            Changes take effect after a restart of the changed Agent. The other
            Agents keep running.{" "}
            {isDraftDirty(state) ? (
              <Badge color="amber">unsaved raw edits</Badge>
            ) : null}
          </>
        }
        title={`Config · ${agent}`}
      />
      <ErrorText error={state.loadError} />
      <ErrorText error={state.saveError} />
      <PendingRestartBar agent={agent} />
      <Tabs defaultValue="settings">
        <TabsList
          aria-label="Config editors"
          className="mb-3 flex gap-2 border-b border-zinc-200 dark:border-zinc-800"
        >
          <TabsTab
            className="px-3 py-2 text-sm data-[selected]:border-b-2 data-[selected]:border-indigo-600 data-[selected]:font-semibold"
            value="settings"
          >
            Agent settings
          </TabsTab>
          <TabsTab
            className="px-3 py-2 text-sm data-[selected]:border-b-2 data-[selected]:border-indigo-600 data-[selected]:font-semibold"
            value="raw"
          >
            Raw YAML
          </TabsTab>
        </TabsList>
        <TabsPanel value="settings">
          {source === undefined ? (
            <Empty>
              {state.loading
                ? "Loading…"
                : `config.yaml has no Agent named ${agent}.`}
            </Empty>
          ) : (
            <AgentSettings agent={agent} source={source} />
          )}
        </TabsPanel>
        <TabsPanel value="raw">
          <RawEditor />
        </TabsPanel>
      </Tabs>
    </div>
  );
};
