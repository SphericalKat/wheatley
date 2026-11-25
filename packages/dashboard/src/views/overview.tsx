import type { AgentHealth } from "@wheatley-ai/protocol";

import { useServices, useStore } from "../hooks.js";
import { formatRoute } from "../router.js";
import { CreateAgentButton } from "./agent-admin.js";
import {
  ActionButton,
  Badge,
  Empty,
  ErrorText,
  formatDuration,
  formatTime,
  PageHeader,
  Panel,
  StateBadge,
} from "./ui.js";

const ExtensionList = ({
  items,
  label,
}: {
  readonly label: string;
  readonly items: readonly {
    readonly name: string;
    readonly state: string;
    readonly error?: string;
  }[];
}) => (
  <div>
    <h3 className="mb-1 text-xs font-semibold tracking-wide text-zinc-500 uppercase">
      {label}
    </h3>
    {items.length === 0 ? (
      <p className="text-sm text-zinc-500">None</p>
    ) : (
      <ul className="space-y-1">
        {items.map((item) => (
          <li
            className="flex flex-wrap items-center gap-2 text-sm"
            key={item.name}
          >
            <span className="font-mono">{item.name}</span>
            <StateBadge state={item.state} />
            {item.error === undefined ? null : (
              <span className="text-xs text-red-600">{item.error}</span>
            )}
          </li>
        ))}
      </ul>
    )}
  </div>
);

const AgentCard = ({ agent }: { readonly agent: AgentHealth }) => {
  const { deployment } = useServices();
  const running = agent.state === "running" || agent.state === "starting";

  return (
    <Panel
      actions={
        <>
          {running ? (
            <ActionButton
              onClick={async () => {
                await deployment.control(agent.name, "stop");
              }}
            >
              Stop
            </ActionButton>
          ) : (
            <ActionButton
              onClick={async () => {
                await deployment.control(agent.name, "start");
              }}
            >
              Start
            </ActionButton>
          )}
          <ActionButton
            onClick={async () => {
              await deployment.control(agent.name, "restart");
            }}
            tone={agent.pendingRestart ? "primary" : "neutral"}
          >
            Restart
          </ActionButton>
        </>
      }
      title={
        <span className="flex items-center gap-2">
          <a
            className="hover:underline"
            href={formatRoute({ agent: agent.name, view: "chat" })}
          >
            {agent.name}
          </a>
          <StateBadge state={agent.state} />
          {agent.pendingRestart ? (
            <Badge color="amber">restart pending</Badge>
          ) : null}
        </span>
      }
    >
      <dl className="mb-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-zinc-500">Active Runs</dt>
          <dd>{agent.activeRuns}</dd>
        </div>
        <div>
          <dt className="text-zinc-500">Next restart attempt</dt>
          <dd>
            {agent.restartBackoffMs === null
              ? "–"
              : `in ${formatDuration(agent.restartBackoffMs)}`}
          </dd>
        </div>
        <div className="col-span-2 sm:col-span-1">
          <dt className="text-zinc-500">Last error</dt>
          <dd className="break-words text-red-600">{agent.lastError ?? "–"}</dd>
        </div>
      </dl>
      <div className="grid gap-3 sm:grid-cols-3">
        <ExtensionList
          items={agent.frontends.map((binding) => ({
            ...binding,
            name: `${binding.id} (${binding.type})`,
          }))}
          label="Frontend Bindings"
        />
        <ExtensionList items={agent.plugins} label="Plugins" />
        <ExtensionList items={agent.mcpServers} label="MCP Servers" />
      </div>
      {agent.skillWarnings.length === 0 ? null : (
        <ul className="mt-3 list-disc pl-5 text-sm text-amber-700">
          {agent.skillWarnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
    </Panel>
  );
};

/** The Overview and Health view: the daemon, Concurrency Gates, and every Agent. */
export const OverviewView = () => {
  const { client, deployment } = useServices();
  const { actionError, error, loading, status } = useStore(deployment.state);
  const connection = useStore(client.state);

  if (status === null) {
    return (
      <>
        <PageHeader title="Overview" />
        {loading ? (
          <Empty>Loading the daemon status…</Empty>
        ) : (
          <ErrorText error={error} />
        )}
      </>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader
        actions={<CreateAgentButton />}
        subtitle={`Wheatley ${status.version} · protocol ${status.protocolVersion} · connection ${connection.status}`}
        title="Overview"
      />
      <ErrorText error={error} />
      <ErrorText error={actionError} />
      <div className="grid gap-4 md:grid-cols-2">
        <Panel title="Daemon">
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <dt className="text-zinc-500">Started</dt>
            <dd>{formatTime(status.startedAt)}</dd>
            <dt className="text-zinc-500">Uptime</dt>
            <dd>{formatDuration(status.uptimeMs)}</dd>
            <dt className="text-zinc-500">Agents</dt>
            <dd>{status.agents.length}</dd>
          </dl>
        </Panel>
        <Panel title="Concurrency Gates">
          {status.concurrency.length === 0 ? (
            <Empty>No provider credentials.</Empty>
          ) : (
            <table className="w-full text-left text-sm">
              <thead className="text-zinc-500">
                <tr>
                  <th className="font-normal">Credential</th>
                  <th className="font-normal">In use</th>
                  <th className="font-normal">Waiting</th>
                </tr>
              </thead>
              <tbody>
                {status.concurrency.map((gate) => (
                  <tr key={gate.credential}>
                    <td className="font-mono">{gate.credential}</td>
                    <td>
                      {gate.inUse} / {gate.limit}
                    </td>
                    <td>{gate.waiting}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>
      {status.agents.length === 0 ? (
        <Empty>
          The Deployment has no Agents. Use Create Agent to add one.
        </Empty>
      ) : (
        status.agents.map((agent) => (
          <AgentCard agent={agent} key={agent.name} />
        ))
      )}
    </div>
  );
};
