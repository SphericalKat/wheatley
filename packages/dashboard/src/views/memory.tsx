import {
  MemoryNameSchema,
  MemorySearchScopeSchema,
  decode,
} from "@wheatley-ai/protocol";
import type { MemorySearchHit, MemorySearchScope } from "@wheatley-ai/protocol";
import { useEffect, useState } from "react";

import { useRpcQuery, useServices } from "../hooks.js";
import { errorMessage } from "../store.js";
import {
  ActionButton,
  ConfirmButton,
  Empty,
  ErrorText,
  Field,
  formatTime,
  inputClass,
  Notice,
  PageHeader,
  Panel,
  StateBadge,
} from "./ui.js";

const MAIN_FILE = "MEMORY";
const SEARCH_LIMIT = 20;
const LOG_LIMIT = 20;
const PERCENT = 100;

/** The share of the `MEMORY.md` budget above which the meter turns red. */
const BUDGET_WARNING_RATIO = 0.9;

const fileLabel = (name: string): string => `${name}.md`;

/** Edits one Memory file. */
const FileEditor = ({
  agent,
  name,
}: {
  readonly agent: string;
  readonly name: string;
}) => {
  const { client } = useServices();

  const file = useRpcQuery(
    "memory.read",
    { agent, name },
    { agent, refreshOn: ["memory.changed"] }
  );

  const loaded = file.data?.content ?? null;
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dirty = draft !== null && draft !== loaded;

  useEffect(() => {
    setDraft(null);
    setError(null);
  }, [agent, name]);

  return (
    <Panel
      actions={
        <>
          <ActionButton
            disabled={!dirty}
            onClick={async () => {
              setError(null);

              try {
                await client.call("memory.write", {
                  agent,
                  content: draft ?? "",
                  mode: "replace",
                  name,
                });
                setDraft(null);
              } catch (error_) {
                setError(errorMessage(error_));
              }
            }}
            tone="primary"
          >
            Save
          </ActionButton>
          {name === MAIN_FILE ? null : (
            <ConfirmButton
              confirmLabel="Delete file"
              description="The Agent no longer finds these facts in Memory searches."
              label="Delete"
              onConfirm={async () => {
                await client.call("memory.delete", { agent, name });
              }}
              title={`Delete ${fileLabel(name)}?`}
            />
          )}
        </>
      }
      title={fileLabel(name)}
    >
      <ErrorText error={file.error ?? error} />
      <textarea
        aria-label={`Content of ${fileLabel(name)}`}
        className={`${inputClass} min-h-64 font-mono`}
        onChange={(event) => {
          setDraft(event.target.value);
        }}
        value={draft ?? loaded ?? ""}
      />
      <p className="mt-1 text-xs text-zinc-500">
        {(draft ?? loaded ?? "").length} characters
      </p>
    </Panel>
  );
};

const SearchHit = ({ hit }: { readonly hit: MemorySearchHit }) => (
  <li className="text-sm">
    <span className="text-xs text-zinc-500">
      {hit.kind === "memory"
        ? fileLabel(hit.name)
        : `${hit.role} in ${hit.conversationId} · ${formatTime(hit.at)}`}
      {` · score ${hit.score.toFixed(2)}`}
    </span>
    <p className="whitespace-pre-wrap">{hit.snippet}</p>
  </li>
);

/** Searches Memory and past Conversations. */
const Search = ({ agent }: { readonly agent: string }) => {
  const { client } = useServices();
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<MemorySearchScope>("all");
  const [hits, setHits] = useState<readonly MemorySearchHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const search = async (): Promise<void> => {
    if (query.trim() === "") {
      return;
    }

    setError(null);

    try {
      const result = await client.call("memory.search", {
        agent,
        limit: SEARCH_LIMIT,
        query,
        scope,
      });

      setHits(result.hits);
    } catch (error_) {
      setError(errorMessage(error_));
    }
  };

  return (
    <Panel title="Search">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
      >
        <Field label="Query">
          <input
            className={inputClass}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
            value={query}
          />
        </Field>
        <Field label="Where">
          <select
            className={inputClass}
            onChange={(event) => {
              const decoded = decode(
                MemorySearchScopeSchema,
                event.target.value
              );

              if (decoded.ok) {
                setScope(decoded.value);
              }
            }}
            value={scope}
          >
            <option value="all">Memory and Conversations</option>
            <option value="memory">Memory files</option>
            <option value="conversations">Conversations</option>
          </select>
        </Field>
        <ActionButton onClick={search}>Search</ActionButton>
      </form>
      <ErrorText error={error} />
      {hits === null ? null : (
        <ul className="mt-3 space-y-2">
          {hits.length === 0 ? <Empty>No results.</Empty> : null}
          {hits.map((hit, index) => (
            // Hits have no IDs, and a new search replaces the whole list.
            <SearchHit hit={hit} key={`${hit.kind}-${index}`} />
          ))}
        </ul>
      )}
    </Panel>
  );
};

/** Forgets the messages of one Conversation. */
const PurgeConversation = ({ agent }: { readonly agent: string }) => {
  const { client } = useServices();
  const [conversationId, setConversationId] = useState("");
  const [result, setResult] = useState<string | null>(null);

  return (
    <Panel title="Forget a Conversation">
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Conversation ID">
          <input
            className={inputClass}
            onChange={(event) => {
              setConversationId(event.target.value);
            }}
            value={conversationId}
          />
        </Field>
        <ConfirmButton
          confirmLabel="Purge messages"
          description="Wheatley deletes the stored messages of this Conversation."
          disabled={conversationId.trim() === ""}
          label="Purge"
          onConfirm={async () => {
            const { purgedMessages } = await client.call(
              "memory.purgeConversation",
              {
                agent,
                conversationId: conversationId.trim(),
              }
            );

            setResult(`Purged ${purgedMessages} messages.`);
          }}
          title="Purge this Conversation?"
        />
      </div>
      {result === null ? null : <p className="mt-2 text-sm">{result}</p>}
    </Panel>
  );
};

/** The Memory view: Memory files, the `MEMORY.md` budget, search, reindex, and consolidation. */
export const MemoryView = ({ agent }: { readonly agent: string }) => {
  const { client } = useServices();

  const list = useRpcQuery(
    "memory.list",
    { agent },
    { agent, refreshOn: ["memory.changed"] }
  );

  const log = useRpcQuery(
    "memory.consolidationLog",
    { agent, limit: LOG_LIMIT },
    { agent, refreshOn: ["memory.changed", "run.finished"] }
  );

  const [selected, setSelected] = useState(MAIN_FILE);
  const [newName, setNewName] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSelected(MAIN_FILE);
  }, [agent]);

  const run = async (action: () => Promise<string>): Promise<void> => {
    setError(null);
    setMessage(null);

    try {
      setMessage(await action());
    } catch (error_) {
      setError(errorMessage(error_));
    }
  };

  const budget = list.data?.budget;

  const used =
    budget === undefined || budget.maxChars === 0
      ? 0
      : budget.usedChars / budget.maxChars;

  return (
    <div className="space-y-4">
      <PageHeader
        actions={
          <>
            <ActionButton
              onClick={async () => {
                await run(async () => {
                  const { files } = await client.call("memory.reindex", {
                    agent,
                  });

                  return `Reindexed ${files} files.`;
                });
              }}
            >
              Reindex
            </ActionButton>
            <ActionButton
              onClick={async () => {
                await run(async () => {
                  const { runId } = await client.call("memory.consolidate", {
                    agent,
                  });

                  return `Consolidation started as Run ${runId}.`;
                });
              }}
              tone="primary"
            >
              Consolidate now
            </ActionButton>
          </>
        }
        title={`Memory · ${agent}`}
      />
      <ErrorText error={list.error ?? error} />
      {message === null ? null : <Notice>{message}</Notice>}
      <div className="grid gap-4 lg:grid-cols-[16rem_1fr]">
        <Panel title="Files">
          {budget === undefined ? null : (
            <div className="mb-3 text-xs">
              <p>
                MEMORY.md uses {budget.usedChars} of {budget.maxChars}{" "}
                characters
              </p>
              <div className="mt-1 h-2 rounded bg-zinc-200 dark:bg-zinc-800">
                <div
                  className={`h-2 rounded ${used > BUDGET_WARNING_RATIO ? "bg-red-500" : "bg-indigo-500"}`}
                  style={{ width: `${Math.min(PERCENT, used * PERCENT)}%` }}
                />
              </div>
            </div>
          )}
          <ul className="space-y-1 text-sm">
            {(list.data?.files ?? []).map((file) => (
              <li key={file.name}>
                <button
                  className={`w-full text-left hover:underline ${selected === file.name ? "font-bold" : ""}`}
                  onClick={() => {
                    setSelected(file.name);
                  }}
                  type="button"
                >
                  {fileLabel(file.name)}
                </button>
                <span className="block text-xs text-zinc-500">
                  {file.chars} characters · {formatTime(file.updatedAt)}
                </span>
              </li>
            ))}
          </ul>
          <form
            className="mt-3 flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
            }}
          >
            <input
              aria-label="New file name"
              className={inputClass}
              onChange={(event) => {
                setNewName(event.target.value);
              }}
              placeholder="new-file"
              value={newName}
            />
            <ActionButton
              onClick={async () => {
                await run(async () => {
                  if (!decode(MemoryNameSchema, newName).ok) {
                    throw new Error(
                      "Use lowercase letters, digits, and hyphens for a file name."
                    );
                  }

                  await client.call("memory.write", {
                    agent,
                    content: "",
                    mode: "append",
                    name: newName,
                  });
                  setSelected(newName);
                  setNewName("");

                  return `Created ${fileLabel(newName)}.`;
                });
              }}
            >
              Add
            </ActionButton>
          </form>
        </Panel>
        <FileEditor agent={agent} name={selected} />
      </div>
      <Search agent={agent} />
      <Panel title="Consolidation log">
        <ErrorText error={log.error} />
        {(log.data?.entries ?? []).length === 0 ? (
          <Empty>No consolidation ran yet.</Empty>
        ) : (
          <ul className="space-y-2 text-sm">
            {(log.data?.entries ?? []).map((entry) => (
              <li className="flex flex-wrap items-center gap-2" key={entry.id}>
                <StateBadge state={entry.status} />
                <span className="text-zinc-500">
                  {formatTime(entry.startedAt)}
                </span>
                <span>{entry.summary ?? entry.error ?? ""}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <PurgeConversation agent={agent} />
    </div>
  );
};
