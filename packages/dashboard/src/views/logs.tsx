import { LogLevelSchema, decode } from "@wheatley/protocol";
import type { LogLevel } from "@wheatley/protocol";
import { useState } from "react";

import { useServices, useStore } from "../hooks.js";
import { agentNames } from "../models/deployment.js";
import type { LogFilter } from "../models/logs.js";
import {
  Badge,
  Empty,
  ErrorText,
  Field,
  inputClass,
  PageHeader,
  Panel,
} from "./ui.js";
import type { BadgeColor } from "./ui.js";

const LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

const LEVEL_COLORS: Record<LogLevel, BadgeColor> = {
  debug: "zinc",
  error: "red",
  info: "indigo",
  warn: "amber",
};

const ALL = "";

/** A `LogFilter` under construction. */
interface LogFilterDraft {
  agent?: string;
  level?: LogLevel;
  module?: string;
}

const parseLevel = (value: string): LogLevel | undefined => {
  const decoded = decode(LogLevelSchema, value);

  return decoded.ok ? decoded.value : undefined;
};

/** Builds a filter from the form fields. An empty field matches everything. */
const toFilter = (agent: string, level: string, module: string): LogFilter => {
  const filter: LogFilterDraft = {};
  const parsedLevel = parseLevel(level);

  if (agent !== ALL) {
    filter.agent = agent;
  }

  if (parsedLevel !== undefined) {
    filter.level = parsedLevel;
  }

  if (module.trim() !== "") {
    filter.module = module.trim();
  }

  return filter;
};

/** The Logs view: the diagnostic log tail of the daemon, live. */
export const LogsView = () => {
  const { deployment, logs } = useServices();
  const { error, filter, loading, records } = useStore(logs.state);
  const agents = agentNames(useStore(deployment.state));
  const [agent, setAgent] = useState(filter.agent ?? ALL);
  const [level, setLevel] = useState<string>(filter.level ?? ALL);
  const [module, setModule] = useState(filter.module ?? "");

  const apply = (
    nextAgent: string,
    nextLevel: string,
    nextModule: string
  ): void => {
    void logs.setFilter(toFilter(nextAgent, nextLevel, nextModule));
  };

  return (
    <div className="space-y-4">
      <PageHeader
        subtitle="Records never contain secret values."
        title="Logs"
      />
      <Panel title="Filter">
        <form
          className="grid gap-3 sm:grid-cols-3"
          onSubmit={(event) => {
            event.preventDefault();
            apply(agent, level, module);
          }}
        >
          <Field label="Agent">
            <select
              className={inputClass}
              onChange={(event) => {
                setAgent(event.target.value);
                apply(event.target.value, level, module);
              }}
              value={agent}
            >
              <option value={ALL}>All Agents and the daemon</option>
              {agents.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Lowest level">
            <select
              className={inputClass}
              onChange={(event) => {
                setLevel(event.target.value);
                apply(agent, event.target.value, module);
              }}
              value={level}
            >
              <option value={ALL}>debug</option>
              {LEVELS.slice(1).map((entry) => (
                <option key={entry} value={entry}>
                  {entry}
                </option>
              ))}
            </select>
          </Field>
          <Field hint="Press Enter to apply." label="Module">
            <input
              className={inputClass}
              onBlur={() => {
                apply(agent, level, module);
              }}
              onChange={(event) => {
                setModule(event.target.value);
              }}
              placeholder="for example outbox"
              value={module}
            />
          </Field>
        </form>
      </Panel>
      <ErrorText error={error} />
      <Panel title={`Records (${records.length})`}>
        {records.length === 0 ? (
          <Empty>{loading ? "Loading…" : "No records match the filter."}</Empty>
        ) : (
          <ol className="max-h-[60vh] space-y-1 overflow-y-auto font-mono text-xs">
            {records.toReversed().map((record) => (
              <li
                className="flex flex-wrap items-baseline gap-2"
                key={record.seq}
              >
                <span className="text-zinc-500">
                  {new Date(record.at).toLocaleTimeString()}
                </span>
                <Badge color={LEVEL_COLORS[record.level]}>{record.level}</Badge>
                <span className="text-zinc-500">{record.module}</span>
                {record.agent === undefined ? null : (
                  <span>[{record.agent}]</span>
                )}
                <span className="whitespace-pre-wrap">{record.message}</span>
                {record.fields === undefined ? null : (
                  <span className="text-zinc-500">
                    {JSON.stringify(record.fields)}
                  </span>
                )}
              </li>
            ))}
          </ol>
        )}
      </Panel>
    </div>
  );
};
