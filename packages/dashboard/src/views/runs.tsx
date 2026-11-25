import type { RunSummary, RunTimelineItem } from "@wheatley/protocol";
import { useEffect, useState } from "react";

import { useEvent, useRpcQuery, useServices } from "../hooks.js";
import { errorMessage } from "../store.js";
import {
  ActionButton,
  Empty,
  ErrorText,
  formatTime,
  PageHeader,
  Panel,
  StateBadge,
} from "./ui.js";

const PAGE_SIZE = 50;

/** Live progress of one active Run from `run.*` events. */
interface LiveRun {
  readonly text: string;
  readonly tools: readonly {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly inputPreview: string;
    readonly outputPreview?: string;
    readonly isError?: boolean;
  }[];
}

const EMPTY_LIVE: LiveRun = { text: "", tools: [] };

const isActive = (run: RunSummary): boolean =>
  run.status === "running" || run.status === "waiting_approval";

const describeOrigin = (run: RunSummary): string => {
  if (run.origin.kind === "chat") {
    return `Chat ${run.origin.bindingId} / ${run.origin.chatId}`;
  }

  if (run.origin.kind === "trigger") {
    return `Trigger ${run.origin.triggerId}`;
  }

  return `Maintenance ${run.origin.job}`;
};

/** Follows `run.delta` and `run.tool*` events of one Agent. */
const useLiveRuns = (agent: string): ReadonlyMap<string, LiveRun> => {
  const [live, setLive] = useState<ReadonlyMap<string, LiveRun>>(new Map());

  useEffect(() => {
    setLive(new Map());
  }, [agent]);

  const change = (runId: string, update: (run: LiveRun) => LiveRun): void => {
    setLive((current) =>
      new Map(current).set(runId, update(current.get(runId) ?? EMPTY_LIVE))
    );
  };

  useEvent("run.delta", (payload) => {
    if (payload.agent === agent) {
      change(payload.runId, (run) => ({
        ...run,
        text: `${run.text}${payload.delta}`,
      }));
    }
  });
  useEvent("run.toolStarted", (payload) => {
    if (payload.agent === agent) {
      change(payload.runId, (run) => ({
        ...run,
        tools: [
          ...run.tools,
          {
            inputPreview: payload.inputPreview,
            toolCallId: payload.toolCallId,
            toolName: payload.toolName,
          },
        ],
      }));
    }
  });
  useEvent("run.toolFinished", (payload) => {
    if (payload.agent === agent) {
      change(payload.runId, (run) => ({
        ...run,
        tools: run.tools.map((tool) =>
          tool.toolCallId === payload.toolCallId
            ? {
                ...tool,
                isError: payload.isError,
                outputPreview: payload.outputPreview,
              }
            : tool
        ),
      }));
    }
  });

  return live;
};

const TimelineItem = ({ item }: { readonly item: RunTimelineItem }) => {
  if (item.kind === "user_message") {
    return (
      <li>
        <span className="text-xs text-zinc-500">
          {formatTime(item.at)} · {item.senderDisplayName ?? "User"}
        </span>
        <p className="whitespace-pre-wrap">{item.text}</p>
      </li>
    );
  }

  if (item.kind === "assistant_text") {
    return (
      <li>
        <span className="text-xs text-zinc-500">
          {formatTime(item.at)} · Agent
        </span>
        <p className="whitespace-pre-wrap">{item.text}</p>
      </li>
    );
  }

  if (item.kind === "tool_call") {
    return (
      <li className="rounded border border-zinc-200 p-2 dark:border-zinc-800">
        <span className="font-mono text-xs">
          {item.toolName} {item.isError === true ? "(error)" : ""}
        </span>
        <pre className="overflow-x-auto text-xs">{item.inputPreview}</pre>
        {item.outputPreview === undefined ? null : (
          <pre className="overflow-x-auto text-xs text-zinc-500">
            {item.outputPreview}
          </pre>
        )}
      </li>
    );
  }

  return (
    <li className="text-sm">
      Approval for <span className="font-mono">{item.toolName}</span>:{" "}
      {item.decision ?? "waiting"}
    </li>
  );
};

const RunDetail = ({
  agent,
  live,
  runId,
}: {
  readonly agent: string;
  readonly runId: string;
  readonly live: LiveRun | undefined;
}) => {
  const detail = useRpcQuery(
    "runs.get",
    { agent, runId },
    {
      agent,
      refreshOn: ["run.finished", "run.toolFinished", "approval.resolved"],
    }
  );

  return (
    <Panel title={`Run ${runId}`}>
      <ErrorText error={detail.error} />
      {detail.data === null ? (
        <Empty>Loading…</Empty>
      ) : (
        <div className="space-y-3 text-sm">
          <dl className="grid grid-cols-2 gap-1">
            <dt className="text-zinc-500">Origin</dt>
            <dd>{describeOrigin(detail.data.run)}</dd>
            <dt className="text-zinc-500">Conversation</dt>
            <dd className="font-mono">{detail.data.run.conversationId}</dd>
            <dt className="text-zinc-500">Model</dt>
            <dd>{detail.data.run.model ?? "–"}</dd>
            <dt className="text-zinc-500">Tokens</dt>
            <dd>
              {detail.data.run.usage === undefined
                ? "–"
                : `${detail.data.run.usage.inputTokens} in / ${detail.data.run.usage.outputTokens} out`}
            </dd>
            <dt className="text-zinc-500">Cost</dt>
            <dd>
              {detail.data.run.usage?.costUsd === undefined
                ? "–"
                : `$${detail.data.run.usage.costUsd.toFixed(4)}`}
            </dd>
          </dl>
          <ErrorText error={detail.data.run.error ?? null} />
          <ol className="space-y-2">
            {detail.data.timeline.map((item, index) => (
              // The timeline has no item IDs, and it only grows at the end.
              <TimelineItem item={item} key={`${item.kind}-${index}`} />
            ))}
          </ol>
          {live === undefined || !isActive(detail.data.run) ? null : (
            <div className="rounded bg-zinc-100 p-2 dark:bg-zinc-950">
              <p className="mb-1 text-xs text-zinc-500">Live</p>
              {live.tools.map((tool) => (
                <p className="font-mono text-xs" key={tool.toolCallId}>
                  {tool.toolName}{" "}
                  {tool.outputPreview === undefined ? "…" : "done"}
                </p>
              ))}
              <p className="whitespace-pre-wrap">{live.text}</p>
            </div>
          )}
        </div>
      )}
    </Panel>
  );
};

/** The Runs view: live and persisted Runs of one Agent, with Stop for active Runs. */
export const RunsView = ({ agent }: { readonly agent: string }) => {
  const { client } = useServices();
  const [onlyActive, setOnlyActive] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [older, setOlder] = useState<readonly RunSummary[]>([]);
  const [olderHasMore, setOlderHasMore] = useState<boolean | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const live = useLiveRuns(agent);
  const status = onlyActive ? "active" : "all";

  const list = useRpcQuery(
    "runs.list",
    { agent, limit: PAGE_SIZE, status },
    { agent, refreshOn: ["run.started", "run.finished"] }
  );

  useEffect(() => {
    setOlder([]);
    setOlderHasMore(null);
    setSelected(null);
  }, [agent, status]);

  // A new Run shifts the first page, so a Run can be in both the first page and an older page.
  const runs = [
    ...new Map(
      [...(list.data?.runs ?? []), ...older].map((run) => [run.runId, run])
    ).values(),
  ];

  const hasMore = olderHasMore ?? list.data?.hasMore ?? false;

  const loadOlder = async (): Promise<void> => {
    const last = runs.at(-1);

    if (last === undefined) {
      return;
    }

    try {
      const page = await client.call("runs.list", {
        agent,
        before: last.runId,
        limit: PAGE_SIZE,
        status,
      });

      setOlder((current) => [...current, ...page.runs]);
      setOlderHasMore(page.hasMore);
    } catch (error) {
      setActionError(errorMessage(error));
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader
        actions={
          <label className="flex items-center gap-2 text-sm">
            <input
              checked={onlyActive}
              onChange={(event) => {
                setOnlyActive(event.target.checked);
              }}
              type="checkbox"
            />
            Active Runs only
          </label>
        }
        title={`Runs · ${agent}`}
      />
      <ErrorText error={list.error} />
      <ErrorText error={actionError} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Runs">
          {runs.length === 0 ? (
            <Empty>{list.loading ? "Loading…" : "No Runs."}</Empty>
          ) : (
            <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
              {runs.map((run) => (
                <li
                  className="flex flex-wrap items-center gap-2 py-2 text-sm"
                  key={run.runId}
                >
                  <button
                    className={`font-mono hover:underline ${selected === run.runId ? "font-bold" : ""}`}
                    onClick={() => {
                      setSelected(run.runId);
                    }}
                    type="button"
                  >
                    {run.runId}
                  </button>
                  <StateBadge state={run.status} />
                  <span className="text-zinc-500">{describeOrigin(run)}</span>
                  <span className="text-zinc-500">
                    {formatTime(run.startedAt)}
                  </span>
                  {isActive(run) ? (
                    <ActionButton
                      onClick={async () => {
                        setActionError(null);

                        try {
                          const { stopped } = await client.call("runs.stop", {
                            agent,
                            runId: run.runId,
                          });

                          if (!stopped) {
                            setActionError(
                              `Run ${run.runId} had already ended.`
                            );
                          }
                        } catch (error) {
                          setActionError(errorMessage(error));
                        }
                      }}
                      tone="danger"
                    >
                      Stop
                    </ActionButton>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {hasMore ? (
            <div className="mt-2 text-center">
              <ActionButton onClick={loadOlder}>Load older Runs</ActionButton>
            </div>
          ) : null}
        </Panel>
        {selected === null ? (
          <Panel title="Run detail">
            <Empty>Select a Run to see its timeline.</Empty>
          </Panel>
        ) : (
          <RunDetail agent={agent} live={live.get(selected)} runId={selected} />
        )}
      </div>
    </div>
  );
};
