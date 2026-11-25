import { CommandNameSchema, decode } from "@wheatley/protocol";
import type { AttachmentUpload, ChatMessage } from "@wheatley/protocol";
import { useCallback, useEffect, useState } from "react";

import { useEvent, useServices } from "../hooks.js";
import { errorMessage } from "../store.js";
import {
  ActionButton,
  Badge,
  Empty,
  ErrorText,
  formatTime,
  inputClass,
  PageHeader,
} from "./ui.js";

/** The Chat that the CLI and the dashboard share (ADR 0005). */
const CLI_BINDING = "cli";
const CLI_CHAT = "default";
const PAGE_SIZE = 50;
const SENDER = "Operator";
const COMMAND = /^\/(?<name>[a-z]+)(?:\s+(?<args>.*))?$/su;
const BASE64_CHUNK = 0x80_00;

/** Encodes a file as base64 in chunks, so large files do not overflow the argument limit of `fromCharCode`. */
const toBase64 = async (file: File): Promise<string> => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const chunks: string[] = [];

  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK) {
    chunks.push(
      String.fromCodePoint(...bytes.subarray(offset, offset + BASE64_CHUNK))
    );
  }

  return btoa(chunks.join(""));
};

const toUploads = async (files: readonly File[]): Promise<AttachmentUpload[]> =>
  await Promise.all(
    files.map(async (file) => ({
      data: await toBase64(file),
      filename: file.name,
      mimeType: file.type === "" ? "application/octet-stream" : file.type,
    }))
  );

interface ChatState {
  readonly messages: readonly ChatMessage[];
  readonly hasMore: boolean;
  readonly loading: boolean;
  readonly error: string | null;
  /** Streamed text of CLI Chat Runs that have no final message yet, by Run ID. */
  readonly streaming: ReadonlyMap<string, string>;
}

const EMPTY_CHAT: ChatState = {
  error: null,
  hasMore: false,
  loading: true,
  messages: [],
  streaming: new Map(),
};

const withoutRun = (
  streaming: ReadonlyMap<string, string>,
  runId: string | undefined
): ReadonlyMap<string, string> => {
  if (runId === undefined || !streaming.has(runId)) {
    return streaming;
  }

  const next = new Map(streaming);

  next.delete(runId);

  return next;
};

/** Loads the CLI Chat of `agent` and follows its live messages and streamed Run text. */
const useChat = (agent: string) => {
  const { client } = useServices();
  const [state, setState] = useState<ChatState>(EMPTY_CHAT);

  const load = useCallback(async () => {
    setState(EMPTY_CHAT);

    try {
      const history = await client.call("chat.history", {
        agent,
        limit: PAGE_SIZE,
      });

      setState((current) => ({
        ...current,
        error: null,
        hasMore: history.hasMore,
        loading: false,
        messages: history.messages,
      }));
    } catch (error) {
      setState((current) => ({
        ...current,
        error: errorMessage(error),
        loading: false,
      }));
    }
  }, [client, agent]);

  useEffect(() => {
    void load();

    return client.onReady(() => {
      void load();
    });
  }, [client, load]);

  useEvent("chat.message", (payload) => {
    if (payload.agent !== agent) {
      return;
    }

    setState((current) => {
      const known = current.messages.some(
        (message) => message.messageId === payload.message.messageId
      );

      return {
        ...current,
        messages: known
          ? current.messages
          : [...current.messages, payload.message],
        streaming: withoutRun(current.streaming, payload.message.runId),
      };
    });
  });

  useEvent("run.started", ({ agent: runAgent, run }) => {
    const inCliChat =
      run.origin.kind === "chat" &&
      run.origin.bindingId === CLI_BINDING &&
      run.origin.chatId === CLI_CHAT;

    if (runAgent === agent && inCliChat) {
      setState((current) => ({
        ...current,
        streaming: new Map(current.streaming).set(run.runId, ""),
      }));
    }
  });

  useEvent("run.delta", (payload) => {
    if (payload.agent !== agent) {
      return;
    }

    setState((current) => {
      const text = current.streaming.get(payload.runId);

      return text === undefined
        ? current
        : {
            ...current,
            streaming: new Map(current.streaming).set(
              payload.runId,
              `${text}${payload.delta}`
            ),
          };
    });
  });

  useEvent("run.finished", (payload) => {
    if (payload.agent === agent) {
      setState((current) => ({
        ...current,
        streaming: withoutRun(current.streaming, payload.run.runId),
      }));
    }
  });

  const loadOlder = async (): Promise<void> => {
    const [oldest] = state.messages;

    if (oldest === undefined) {
      return;
    }

    try {
      const older = await client.call("chat.history", {
        agent,
        before: oldest.messageId,
        limit: PAGE_SIZE,
      });

      setState((current) => ({
        ...current,
        hasMore: older.hasMore,
        messages: [...older.messages, ...current.messages],
      }));
    } catch (error) {
      setState((current) => ({ ...current, error: errorMessage(error) }));
    }
  };

  return { loadOlder, state };
};

const MessageBubble = ({ message }: { readonly message: ChatMessage }) => {
  const fromUser = message.role === "user";

  return (
    <li className={`flex ${fromUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[80%] space-y-1 rounded-lg px-3 py-2 text-sm ${
          fromUser
            ? "bg-indigo-600 text-white"
            : "bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100"
        }`}
      >
        <div className="flex flex-wrap items-center gap-2 text-xs opacity-75">
          <span>
            {message.senderDisplayName ?? (fromUser ? "User" : "Agent")}
          </span>
          <span>{formatTime(message.at)}</span>
          {message.source === undefined || message.source === "reply" ? null : (
            <Badge color="zinc">{message.source}</Badge>
          )}
        </div>
        <p className="whitespace-pre-wrap">{message.text}</p>
        {(message.attachments ?? []).map((attachment) => (
          <p className="text-xs opacity-75" key={attachment.filename}>
            Attachment: {attachment.filename} ({attachment.sizeBytes} bytes)
          </p>
        ))}
      </div>
    </li>
  );
};

/** The Chat view: the Agent's CLI Chat (`cli` binding, Chat `default`), which the CLI shares. */
export const ChatView = ({ agent }: { readonly agent: string }) => {
  const { client } = useServices();
  const { loadOlder, state } = useChat(agent);
  const [text, setText] = useState("");
  const [files, setFiles] = useState<readonly File[]>([]);
  const [sendError, setSendError] = useState<string | null>(null);

  const send = async (): Promise<void> => {
    const trimmed = text.trim();

    if (trimmed === "" && files.length === 0) {
      return;
    }

    setSendError(null);

    try {
      const command = COMMAND.exec(trimmed)?.groups;

      if (command?.name !== undefined && files.length === 0) {
        const name = decode(CommandNameSchema, command.name);

        if (!name.ok) {
          throw new Error(`Unknown command /${command.name}`);
        }

        await client.call("chat.command", {
          agent,
          args: command.args,
          name: name.value,
        });
      } else {
        await client.call("chat.send", {
          agent,
          attachments: files.length === 0 ? undefined : await toUploads(files),
          senderDisplayName: SENDER,
          text,
        });
      }

      setText("");
      setFiles([]);
    } catch (error) {
      setSendError(errorMessage(error));
    }
  };

  return (
    <div className="flex h-full flex-col gap-3">
      <PageHeader
        subtitle="The CLI Chat of this Agent. `wheatley chat` shows the same messages."
        title={`Chat · ${agent}`}
      />
      <ErrorText error={state.error} />
      <div className="min-h-[50vh] flex-1 overflow-y-auto rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
        {state.hasMore ? (
          <div className="mb-2 text-center">
            <ActionButton onClick={loadOlder}>Load older messages</ActionButton>
          </div>
        ) : null}
        {state.messages.length === 0 && state.streaming.size === 0 ? (
          <Empty>{state.loading ? "Loading…" : "No messages yet."}</Empty>
        ) : (
          <ul className="space-y-2">
            {state.messages.map((message) => (
              <MessageBubble key={message.messageId} message={message} />
            ))}
            {[...state.streaming].map(([runId, streamed]) => (
              <li className="flex justify-start" key={runId}>
                <p className="max-w-[80%] rounded-lg bg-zinc-100 px-3 py-2 text-sm whitespace-pre-wrap text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                  {streamed === "" ? "Working…" : streamed}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
      <form
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <textarea
          aria-label="Message"
          className={`${inputClass} min-h-20`}
          onChange={(event) => {
            setText(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
          placeholder="Message, or a command such as /new, /compact, /stop, /status"
          value={text}
        />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <input
            aria-label="Attachments"
            className="text-sm"
            multiple
            onChange={(event) => {
              setFiles([...(event.target.files ?? [])]);
            }}
            type="file"
          />
          <ActionButton onClick={send} tone="primary">
            Send
          </ActionButton>
        </div>
        <ErrorText error={sendError} />
      </form>
    </div>
  );
};
