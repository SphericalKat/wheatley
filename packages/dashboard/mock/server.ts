import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

import {
  decode,
  decodeClientMessage,
  DeploymentConfigSchema,
  encodeError,
  encodeEvent,
  encodeResult,
  eventTopic,
  isJsonValue,
  PROTOCOL_VERSION,
  RpcError,
  RpcErrorCode,
} from "@wheatley-ai/protocol";
import type {
  AgentConfig,
  AgentHealth,
  ChatMessage,
  ConfigIssue,
  DeploymentConfig,
  EventName,
  EventPayload,
  EventTopic,
  LogRecord,
  MethodName,
  MethodParams,
  MethodResult,
  ModelRef,
  PendingRestart,
  RunSummary,
  Trigger,
} from "@wheatley-ai/protocol";
import { WebSocketServer } from "ws";
import type { RawData, WebSocket } from "ws";
import { parse } from "yaml";

import {
  configToYaml,
  createFixtureState,
  FIXTURE_MODELS,
} from "./fixtures.js";
import type { FixtureMemoryFile, FixtureState } from "./fixtures.js";

type Handler<M extends MethodName> = (
  params: MethodParams<M>,
  connection: MockConnection
) => MethodResult<M>;

/** A handler for every v1 method. */
export type MockHandlers = { readonly [M in MethodName]: Handler<M> };

interface Subscription {
  readonly agents: ReadonlySet<string> | null;
  readonly topics: ReadonlySet<EventTopic> | null;
}

interface MockConnection {
  readonly id: string;
  readonly socket: WebSocket;
  readonly subscriptions: Map<string, Subscription>;
}

interface QueuedEvent {
  readonly name: EventName;
  readonly agent: string | undefined;
  readonly text: string;
}

/** A mock Wheatley daemon that speaks the v1 JSON-RPC protocol over WebSocket with fixture data. */
export interface MockDaemon {
  /** The fixture state. Tests change it directly to set up a case. */
  readonly state: FixtureState;
  /** The methods of every request received, in order. */
  readonly received: MethodName[];
  /**
   * Sends an event to every connection with a matching subscription. Inside a request handler, the event waits until
   * the response is sent (ADR 0005).
   */
  readonly emit: <E extends EventName>(
    name: E,
    payload: EventPayload<E>
  ) => void;
  /** Replaces the handler of one method, for example to make it fail. */
  readonly override: <M extends MethodName>(
    method: M,
    handler: Handler<M>
  ) => void;
  /** Simulates a hand edit of `config.yaml`: changes the raw text, bumps the revision, and emits `config.changed`. */
  readonly editConfigExternally: (raw: string) => void;
  /** Closes every client connection, as a daemon restart does. */
  readonly dropConnections: () => void;
  /** The number of open client connections. */
  readonly connectionCount: () => number;
  /** Routes one HTTP upgrade request. Returns false if the path is not `/ws`. */
  readonly handleUpgrade: (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer
  ) => boolean;
  /** Closes every connection. */
  readonly close: () => void;
}

/** A mock daemon with its own HTTP listener. */
export interface ListeningMockDaemon extends Omit<MockDaemon, "close"> {
  /** Closes every connection and the listener. */
  readonly close: () => Promise<void>;
  /** The WebSocket URL, for example `ws://127.0.0.1:43210/ws`. */
  readonly url: string;
}

const SOCKET_PATH = "/ws";
const DEFAULT_PAGE = 50;
const CHAT_REPLY_PREFIX = "Fixture reply: ";
const SNIPPET_LENGTH = 200;
const DEFAULT_GATE_LIMIT = 4;

/** Every topic except `config` can carry an Agent. */
const topicHasAgent = (topic: EventTopic): boolean => topic !== "config";

const eventAgent = <E extends EventName>(
  name: E,
  payload: EventPayload<E>
): string | undefined => {
  if ("agent" in payload) {
    return payload.agent;
  }

  return "record" in payload ? payload.record.agent : undefined;
};

const matches = (subscription: Subscription, event: QueuedEvent): boolean => {
  const topic = eventTopic(event.name);

  const topicMatches =
    subscription.topics === null || subscription.topics.has(topic);

  const agentMatches =
    subscription.agents === null ||
    event.agent === undefined ||
    !topicHasAgent(topic) ||
    subscription.agents.has(event.agent);

  return topicMatches && agentMatches;
};

const now = (): string => new Date().toISOString();

const moveKey = <Value>(
  map: Map<string, Value>,
  from: string,
  to: string
): void => {
  const value = map.get(from);

  map.delete(from);

  if (value !== undefined) {
    map.set(to, value);
  }
};

const isAddressInfo = (
  address: string | AddressInfo | null
): address is AddressInfo =>
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Node reports a pipe server's address as a string.
  address !== null && typeof address !== "string";

const rawText = (data: RawData): string => {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf-8");
  }

  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf-8");
  }

  return data.toString("utf-8");
};

/** Parses `config.yaml` text and lists its problems. */
export const parseConfigYaml = (
  raw: string
):
  | { readonly ok: true; readonly config: DeploymentConfig }
  | { readonly ok: false; readonly issues: ConfigIssue[] } => {
  let value: unknown;

  try {
    value = parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return { issues: [{ message, path: "/" }], ok: false };
  }

  if (!isJsonValue(value)) {
    return {
      issues: [{ message: "The file holds non-JSON values", path: "/" }],
      ok: false,
    };
  }

  const decoded = decode(DeploymentConfigSchema, value);

  return decoded.ok
    ? { config: decoded.value, ok: true }
    : { issues: [...decoded.issues], ok: false };
};

/** Creates a mock daemon without a listener. Attach it to an HTTP server with `handleUpgrade`. */
export const createMockDaemon = (
  state: FixtureState = createFixtureState(Date.now())
): MockDaemon => {
  const wss = new WebSocketServer({ noServer: true });
  const connections = new Set<MockConnection>();
  const received: MethodName[] = [];
  const overrides: { [M in MethodName]?: Handler<M> } = {};
  let collecting: QueuedEvent[] | null = null;

  const nextId = (prefix: string): string => {
    state.nextId += 1;

    return `${prefix}-${state.nextId}`;
  };

  const revision = (): string => `rev-${state.revision}`;

  const deliver = (event: QueuedEvent): void => {
    for (const connection of connections) {
      const subscribed = [...connection.subscriptions.values()].some(
        (subscription) => matches(subscription, event)
      );

      if (subscribed) {
        connection.socket.send(event.text);
      }
    }
  };

  const emit = <E extends EventName>(
    name: E,
    payload: EventPayload<E>
  ): void => {
    const event = {
      agent: eventAgent(name, payload),
      name,
      text: encodeEvent(name, payload),
    };

    if (collecting === null) {
      deliver(event);

      return;
    }

    collecting.push(event);
  };

  const log = (
    level: "info" | "warn",
    module: string,
    message: string,
    agent?: string
  ): void => {
    const record: LogRecord = {
      at: now(),
      level,
      message,
      module,
      seq: (state.logs.at(-1)?.seq ?? 0) + 1,
    };

    if (agent !== undefined) {
      record.agent = agent;
    }

    state.logs.push(record);
    emit("log.record", { record });
  };

  const agentConfig = (agent: string): AgentConfig => {
    const config = state.config.agents[agent];

    if (config === undefined) {
      throw new RpcError(RpcErrorCode.AgentNotFound, `No Agent ${agent}`);
    }

    return config;
  };

  const requireRunning = (agent: string): void => {
    agentConfig(agent);

    const runtime = state.runtime.get(agent);

    if (runtime?.state !== "running") {
      throw new RpcError(
        RpcErrorCode.AgentUnavailable,
        `Agent ${agent} is ${runtime?.state ?? "stopped"}`
      );
    }
  };

  const checkRevision = (expected: string): void => {
    if (expected !== revision()) {
      throw new RpcError(
        RpcErrorCode.RevisionConflict,
        "config.yaml changed since you loaded it",
        { revision: revision() }
      );
    }
  };

  const health = (name: string): AgentHealth => {
    const config = agentConfig(name);

    const runtime = state.runtime.get(name) ?? {
      lastError: null,
      restartBackoffMs: null,
      state: "stopped",
    };

    const ready = runtime.state === "running" ? "ready" : "stopped";

    return {
      activeRuns: state.runs.filter(
        (run) =>
          run.agent === name &&
          (run.status === "running" || run.status === "waiting_approval")
      ).length,
      frontends: (config.frontends ?? []).map((binding) => ({
        id: binding.id,
        state: binding.enabled === false ? "disabled" : ready,
        type: binding.type,
      })),
      lastError: runtime.lastError,
      mcpServers: Object.entries(config.mcpServers ?? {}).map(
        ([server, settings]) => ({
          name: server,
          state: settings.enabled === false ? "disabled" : ready,
        })
      ),
      name,
      pendingRestart: state.pendingRestart.some(
        (entry) => entry.kind !== "daemon" && entry.agent === name
      ),
      plugins: (config.plugins ?? []).map((plugin) => ({
        name: plugin.source,
        state: plugin.enabled === false ? "disabled" : ready,
      })),
      restartBackoffMs: runtime.restartBackoffMs,
      skillWarnings: [],
      state: runtime.state,
    };
  };

  const setAgentState = (agent: string, next: AgentHealth["state"]): void => {
    const runtime = state.runtime.get(agent);

    if (runtime === undefined) {
      state.runtime.set(agent, {
        lastError: null,
        restartBackoffMs: null,
        state: next,
      });
    } else {
      runtime.state = next;
    }

    emit("agent.status", { agent, state: next });
  };

  const clearPendingRestart = (agent: string): void => {
    const before = state.pendingRestart.length;

    state.pendingRestart = state.pendingRestart.filter(
      (entry) => entry.kind === "daemon" || entry.agent !== agent
    );

    if (state.pendingRestart.length !== before) {
      emit("config.changed", {
        pendingRestart: state.pendingRestart,
        revision: revision(),
      });
    }
  };

  /** Stores a new config, bumps the revision, and marks or restarts the changed Agents. */
  const commitConfig = (
    next: DeploymentConfig,
    raw: string,
    restart: "none" | "affected"
  ): void => {
    const changed = new Set<string>();

    for (const name of new Set([
      ...Object.keys(state.config.agents),
      ...Object.keys(next.agents),
    ])) {
      const before = JSON.stringify(state.config.agents[name] ?? null);
      const after = JSON.stringify(next.agents[name] ?? null);

      if (before !== after) {
        changed.add(name);
      }
    }

    state.config = next;
    state.raw = raw;
    state.revision += 1;

    const pending: PendingRestart[] = state.pendingRestart.filter(
      (entry) =>
        entry.kind === "daemon" || next.agents[entry.agent] !== undefined
    );

    for (const name of changed) {
      if (next.agents[name] === undefined) {
        state.runtime.delete(name);
        continue;
      }

      if (!state.runtime.has(name) || restart === "affected") {
        const index = pending.findIndex(
          (entry) => entry.kind === "agent" && entry.agent === name
        );

        if (index !== -1) {
          pending.splice(index, 1);
        }

        setAgentState(name, "running");
        continue;
      }

      const alreadyPending = pending.some(
        (entry) => entry.kind === "agent" && entry.agent === name
      );

      if (!alreadyPending) {
        pending.push({ agent: name, kind: "agent" });
      }
    }

    state.pendingRestart = pending;
    emit("config.changed", { pendingRestart: pending, revision: revision() });
    log("info", "config", `Saved config.yaml as ${revision()}`);
  };

  const commitStructured = (
    next: DeploymentConfig,
    restart: "none" | "affected"
  ): void => {
    commitConfig(next, configToYaml(next), restart);
  };

  const addChatMessage = (agent: string, message: ChatMessage): void => {
    const messages = state.chat.get(agent) ?? [];

    messages.push(message);
    state.chat.set(agent, messages);
    emit("chat.message", { agent, message });
  };

  /** Stores a user message in the CLI Chat and returns its ID. */
  const addUserMessage = (
    agent: string,
    text: string,
    senderDisplayName: string | undefined
  ): string => {
    const message: ChatMessage = {
      at: now(),
      messageId: nextId("msg"),
      role: "user",
      text,
    };

    if (senderDisplayName !== undefined) {
      message.senderDisplayName = senderDisplayName;
    }

    addChatMessage(agent, message);

    return message.messageId;
  };

  const chatModel = (agent: string): ModelRef => {
    const { model } = agentConfig(agent);

    return (
      state.chatModels.get(agent) ?? { id: model.id, provider: model.provider }
    );
  };

  /** Switches the CLI Chat model like `/model <args>`, with the reply texts of the real Agent. */
  const changeModel = (agent: string, args: string) => {
    const slash = args.indexOf("/");

    const model: ModelRef =
      slash === -1
        ? { id: args, provider: agentConfig(agent).model.provider }
        : { id: args.slice(slash + 1), provider: args.slice(0, slash) };

    const argument = `${model.provider}/${model.id}`;

    const known = FIXTURE_MODELS.some(
      (entry) => entry.provider === model.provider && entry.id === model.id
    );

    if (!known) {
      return { accepted: false, text: `Unknown model: ${argument}` };
    }

    state.chatModels.set(agent, model);

    return { accepted: true, text: `This Conversation now uses ${argument}.` };
  };

  const conversationOf = (agent: string): string => {
    const existing = state.conversations.get(agent);

    if (existing !== undefined) {
      return existing;
    }

    const created = nextId("conv");

    state.conversations.set(agent, created);

    return created;
  };

  /** Runs a fixture Run that replies with the user text. */
  const replyTo = (agent: string, text: string): RunSummary => {
    const run: RunSummary = {
      agent,
      conversationId: conversationOf(agent),
      endedAt: null,
      origin: { bindingId: "cli", chatId: "default", kind: "chat" },
      runId: nextId("run"),
      startedAt: now(),
      status: "running",
    };

    const reply = `${CHAT_REPLY_PREFIX}${text}`;

    state.runs.unshift(run);
    state.timelines.set(run.runId, [
      { at: run.startedAt, kind: "user_message", text },
    ]);
    emit("run.started", { agent, run });
    emit("run.delta", { agent, delta: reply, runId: run.runId });
    addChatMessage(agent, {
      at: now(),
      messageId: nextId("msg"),
      role: "assistant",
      runId: run.runId,
      source: "reply",
      text: reply,
    });
    state.timelines.get(run.runId)?.push({
      at: now(),
      kind: "assistant_text",
      text: reply,
    });

    const finished: RunSummary = {
      ...run,
      endedAt: now(),
      status: "completed",
      usage: { inputTokens: text.length, outputTokens: reply.length },
    };

    state.runs[state.runs.indexOf(run)] = finished;
    emit("run.finished", { agent, run: finished });

    return run;
  };

  const triggersOf = (agent: string): Trigger[] => {
    agentConfig(agent);

    const list = state.triggers.get(agent) ?? [];

    state.triggers.set(agent, list);

    return list;
  };

  const findTrigger = (agent: string, triggerId: string): Trigger => {
    const trigger = triggersOf(agent).find((entry) => entry.id === triggerId);

    if (trigger === undefined) {
      throw new RpcError(RpcErrorCode.NotFound, `No Trigger ${triggerId}`);
    }

    return trigger;
  };

  const memoryOf = (agent: string) => {
    agentConfig(agent);

    const files =
      state.memory.get(agent) ?? new Map<string, FixtureMemoryFile>();

    state.memory.set(agent, files);

    return files;
  };

  const memoryBudget = (agent: string) => ({
    maxChars: agentConfig(agent).memory?.maxChars ?? state.memoryMaxChars,
    usedChars: memoryOf(agent).get("MEMORY")?.content.length ?? 0,
  });

  const moveAgentData = (from: string, to: string): void => {
    moveKey(state.runtime, from, to);
    moveKey(state.chat, from, to);
    moveKey(state.conversations, from, to);
    moveKey(state.chatModels, from, to);
    moveKey(state.memory, from, to);
    moveKey(state.consolidation, from, to);
    moveKey(state.triggers, from, to);
  };

  const handlers: MockHandlers = {
    "agents.create": ({ agent, config, expectedRevision }) => {
      checkRevision(expectedRevision);

      if (state.config.agents[agent] !== undefined) {
        throw new RpcError(RpcErrorCode.Conflict, `Agent ${agent} exists`);
      }

      commitStructured(
        {
          ...state.config,
          agents: { ...state.config.agents, [agent]: config },
        },
        "none"
      );

      return { revision: revision() };
    },
    "agents.delete": ({ agent, expectedRevision }) => {
      checkRevision(expectedRevision);
      agentConfig(agent);

      const agents = Object.fromEntries(
        Object.entries(state.config.agents).filter(([name]) => name !== agent)
      );

      commitStructured({ ...state.config, agents }, "none");
      state.approvals = state.approvals.filter(
        (approval) => approval.agent !== agent
      );
      state.deliveries = state.deliveries.filter(
        (delivery) => delivery.agent !== agent
      );

      return { revision: revision() };
    },
    "agents.get": ({ agent }) => health(agent),
    "agents.list": () => ({
      agents: Object.keys(state.config.agents).map(health),
    }),
    "agents.rename": ({ agent, expectedRevision, newName }) => {
      checkRevision(expectedRevision);

      const config = agentConfig(agent);

      if (state.config.agents[newName] !== undefined) {
        throw new RpcError(RpcErrorCode.Conflict, `Agent ${newName} exists`);
      }

      moveAgentData(agent, newName);

      const agents = Object.fromEntries(
        Object.entries(state.config.agents).map(([name, settings]) =>
          name === agent ? [newName, config] : [name, settings]
        )
      );

      commitStructured({ ...state.config, agents }, "none");

      return { revision: revision() };
    },
    "agents.restart": ({ agent }) => {
      agentConfig(agent);
      setAgentState(agent, "starting");
      setAgentState(agent, "running");
      clearPendingRestart(agent);

      return { state: "running" };
    },
    "agents.start": ({ agent }) => {
      agentConfig(agent);
      setAgentState(agent, "running");
      clearPendingRestart(agent);

      return { state: "running" };
    },
    "agents.stop": ({ agent }) => {
      agentConfig(agent);
      setAgentState(agent, "stopped");

      return { state: "stopped" };
    },
    "approvals.decide": ({ agent, approvalId, resolution }) => {
      const approval = state.approvals.find(
        (entry) => entry.agent === agent && entry.approvalId === approvalId
      );

      if (approval === undefined) {
        return { accepted: false };
      }

      state.approvals = state.approvals.filter((entry) => entry !== approval);

      const run = state.runs.find((entry) => entry.runId === approval.runId);

      if (run !== undefined && run.status === "waiting_approval") {
        state.runs[state.runs.indexOf(run)] = { ...run, status: "running" };
      }

      const resolved: EventPayload<"approval.resolved"> = {
        agent,
        approvalId,
        decision: resolution.decision,
      };

      if (resolution.reason !== undefined) {
        resolved.reason = resolution.reason;
      }

      if (resolution.resolvedBy !== undefined) {
        resolved.resolvedBy = resolution.resolvedBy;
      }

      emit("approval.resolved", resolved);

      return { accepted: true };
    },
    "approvals.list": ({ agent }) => ({
      approvals: state.approvals.filter(
        (approval) => agent === undefined || approval.agent === agent
      ),
    }),
    "chat.ask": ({ agent, senderDisplayName, text }) => {
      requireRunning(agent);

      const messageId = addUserMessage(agent, text, senderDisplayName);
      const run = replyTo(agent, text);

      return {
        conversationId: run.conversationId,
        messageId,
        runId: run.runId,
      };
    },
    "chat.command": ({ agent, args, name }) => {
      requireRunning(agent);

      if (name === "new") {
        state.conversations.set(agent, nextId("conv"));
      }

      const { accepted, text } =
        name === "model" && args !== undefined
          ? changeModel(agent, args)
          : { accepted: true, text: `Ran /${name}.` };

      addChatMessage(agent, {
        at: now(),
        messageId: nextId("msg"),
        role: "assistant",
        source: "command",
        text,
      });

      return { accepted };
    },
    "chat.history": ({ agent, before, limit }) => {
      agentConfig(agent);

      const messages = state.chat.get(agent) ?? [];

      const end =
        before === undefined
          ? messages.length
          : messages.findIndex((message) => message.messageId === before);

      const stop = end === -1 ? messages.length : end;
      const start = Math.max(0, stop - (limit ?? DEFAULT_PAGE));

      return {
        conversationId: conversationOf(agent),
        hasMore: start > 0,
        messages: messages.slice(start, stop),
      };
    },
    "chat.send": ({ agent, senderDisplayName, text }) => {
      requireRunning(agent);

      const messageId = addUserMessage(agent, text, senderDisplayName);

      replyTo(agent, text);

      return { messageId };
    },
    "config.get": () => ({
      config: state.config,
      pendingRestart: state.pendingRestart,
      raw: state.raw,
      revision: revision(),
    }),
    "config.save": (params) => {
      checkRevision(params.expectedRevision);

      const restart = params.restart ?? "none";

      if ("raw" in params) {
        const parsed = parseConfigYaml(params.raw);

        if (!parsed.ok) {
          throw new RpcError(
            RpcErrorCode.ConfigInvalid,
            "config.yaml is invalid",
            {
              issues: parsed.issues.map(({ message, path }) => ({
                message,
                path,
              })),
            }
          );
        }

        commitConfig(parsed.config, params.raw, restart);
      } else {
        commitStructured(params.config, restart);
      }

      return { pendingRestart: state.pendingRestart, revision: revision() };
    },
    "config.validate": ({ raw }) => {
      const parsed = parseConfigYaml(raw);

      return parsed.ok
        ? { issues: [], valid: true }
        : { issues: parsed.issues, valid: false };
    },
    "deliveries.dismiss": ({ agent, deliveryId }) => {
      const before = state.deliveries.length;

      state.deliveries = state.deliveries.filter(
        (delivery) =>
          delivery.agent !== agent || delivery.deliveryId !== deliveryId
      );

      const dismissed = state.deliveries.length !== before;

      if (dismissed) {
        emit("delivery.cleared", { agent, deliveryId, reason: "dismissed" });
      }

      return { dismissed };
    },
    "deliveries.listFailed": ({ agent }) => ({
      deliveries: state.deliveries.filter(
        (delivery) => agent === undefined || delivery.agent === agent
      ),
    }),
    "deliveries.retry": ({ agent, deliveryId }) => {
      const delivery = state.deliveries.find(
        (entry) => entry.agent === agent && entry.deliveryId === deliveryId
      );

      if (delivery === undefined) {
        throw new RpcError(RpcErrorCode.NotFound, `No delivery ${deliveryId}`);
      }

      state.deliveries = state.deliveries.filter((entry) => entry !== delivery);
      emit("delivery.cleared", { agent, deliveryId, reason: "retried" });

      return { requeued: true };
    },
    "events.subscribe": ({ agents, topics }, connection) => {
      const subscriptionId = nextId("sub");

      connection.subscriptions.set(subscriptionId, {
        agents: agents === undefined ? null : new Set(agents),
        topics: topics === undefined ? null : new Set(topics),
      });

      return { subscriptionId };
    },
    "events.unsubscribe": ({ subscriptionId }, connection) => ({
      removed: connection.subscriptions.delete(subscriptionId),
    }),
    "extensions.list": ({ agent }) => {
      const current = health(agent);

      return {
        frontends: current.frontends,
        mcpServers: current.mcpServers,
        plugins: current.plugins,
        skills: state.skills,
        tools: state.tools,
      };
    },
    "logs.tail": ({ agent, level, limit, module }) => {
      const order = ["debug", "info", "warn", "error"];
      const minimum = order.indexOf(level ?? "debug");

      const records = state.logs.filter(
        (record) =>
          (agent === undefined || record.agent === agent) &&
          (module === undefined || record.module === module) &&
          order.indexOf(record.level) >= minimum
      );

      return { records: records.slice(-(limit ?? DEFAULT_PAGE)) };
    },
    "memory.consolidate": ({ agent }) => {
      requireRunning(agent);

      const runId = nextId("run");
      const entries = state.consolidation.get(agent) ?? [];

      entries.unshift({
        endedAt: now(),
        id: nextId("consolidation"),
        runId,
        startedAt: now(),
        status: "completed",
        summary: "Nothing new to merge.",
      });
      state.consolidation.set(agent, entries);

      return { runId };
    },
    "memory.consolidationLog": ({ agent, limit }) => {
      agentConfig(agent);

      return {
        entries: (state.consolidation.get(agent) ?? []).slice(
          0,
          limit ?? DEFAULT_PAGE
        ),
      };
    },
    "memory.delete": ({ agent, name }) => {
      const deleted = memoryOf(agent).delete(name);

      if (deleted) {
        emit("memory.changed", { agent, change: "deleted", name });
      }

      return { deleted };
    },
    "memory.list": ({ agent }) => ({
      budget: memoryBudget(agent),
      files: [...memoryOf(agent).entries()].map(([name, file]) => ({
        chars: file.content.length,
        name,
        updatedAt: file.updatedAt,
      })),
    }),
    "memory.purgeConversation": ({ agent, conversationId }) => {
      agentConfig(agent);

      if (state.conversations.get(agent) !== conversationId) {
        return { purgedMessages: 0 };
      }

      const purged = state.chat.get(agent)?.length ?? 0;

      state.chat.set(agent, []);

      return { purgedMessages: purged };
    },
    "memory.read": ({ agent, name }) => {
      const file = memoryOf(agent).get(name);

      if (file === undefined) {
        throw new RpcError(RpcErrorCode.NotFound, `No Memory file ${name}`);
      }

      return { content: file.content, name };
    },
    "memory.reindex": ({ agent }) => {
      const files = memoryOf(agent).size;

      emit("memory.changed", { agent, change: "reindexed" });

      return { files };
    },
    "memory.search": ({ agent, limit, query }) => {
      const needle = query.toLowerCase();

      const hits = [...memoryOf(agent).entries()].flatMap(([name, file]) =>
        file.content.toLowerCase().includes(needle)
          ? [
              {
                kind: "memory" as const,
                name,
                score: 1,
                snippet: file.content.slice(0, SNIPPET_LENGTH),
              },
            ]
          : []
      );

      return { hits: hits.slice(0, limit ?? DEFAULT_PAGE) };
    },
    "memory.write": ({ agent, content, mode, name }) => {
      const files = memoryOf(agent);
      const previous = files.get(name)?.content ?? "";
      const next = mode === "append" ? `${previous}${content}` : content;
      const budget = memoryBudget(agent);

      if (name === "MEMORY" && next.length > budget.maxChars) {
        throw new RpcError(
          RpcErrorCode.MemoryBudgetExceeded,
          `MEMORY.md would hold ${next.length} of ${budget.maxChars} characters`
        );
      }

      const updatedAt = now();

      files.set(name, { content: next, updatedAt });
      emit("memory.changed", { agent, change: "written", name });

      return { file: { chars: next.length, name, updatedAt } };
    },
    "models.list": ({ agent }) => {
      const models = [...FIXTURE_MODELS];

      if (agent === undefined) {
        return { models };
      }

      const running = state.runtime.get(agent)?.state === "running";

      return running ? { current: chatModel(agent), models } : { models };
    },
    "runs.get": ({ agent, runId }) => {
      const run = state.runs.find(
        (entry) => entry.agent === agent && entry.runId === runId
      );

      if (run === undefined) {
        throw new RpcError(RpcErrorCode.NotFound, `No Run ${runId}`);
      }

      return { run, timeline: state.timelines.get(runId) ?? [] };
    },
    "runs.list": ({ agent, before, limit, status }) => {
      const runs = state.runs.filter(
        (run) =>
          (agent === undefined || run.agent === agent) &&
          (status !== "active" ||
            run.status === "running" ||
            run.status === "waiting_approval")
      );

      const index =
        before === undefined
          ? 0
          : runs.findIndex((run) => run.runId === before) + 1;

      const page = runs.slice(index, index + (limit ?? DEFAULT_PAGE));

      return { hasMore: index + page.length < runs.length, runs: page };
    },
    "runs.stop": ({ agent, runId }) => {
      const run = state.runs.find(
        (entry) => entry.agent === agent && entry.runId === runId
      );

      const active =
        run !== undefined &&
        (run.status === "running" || run.status === "waiting_approval");

      if (!active) {
        return { stopped: false };
      }

      const stopped: RunSummary = { ...run, endedAt: now(), status: "stopped" };

      state.runs[state.runs.indexOf(run)] = stopped;

      for (const approval of state.approvals.filter(
        (entry) => entry.runId === runId
      )) {
        emit("approval.resolved", {
          agent,
          approvalId: approval.approvalId,
          decision: "cancelled",
        });
      }

      state.approvals = state.approvals.filter(
        (entry) => entry.runId !== runId
      );
      emit("run.finished", { agent, run: stopped });

      return { stopped: true };
    },
    "secrets.delete": ({ name }) => ({ deleted: state.secrets.delete(name) }),
    "secrets.list": () => ({
      secrets: [...state.secrets.entries()].map(([name, secret]) => ({
        name,
        references: secret.references,
        source: secret.source,
      })),
    }),
    "secrets.reveal": ({ name }) => {
      const secret = state.secrets.get(name);

      if (secret === undefined) {
        throw new RpcError(RpcErrorCode.NotFound, `No secret ${name}`);
      }

      return { value: secret.value };
    },
    "secrets.set": ({ name, value }) => {
      const existing = state.secrets.get(name);

      const source =
        existing?.source === "env" ? "both" : (existing?.source ?? "file");

      state.secrets.set(name, {
        references: existing?.references ?? [],
        source,
        value,
      });

      return { source };
    },
    "system.hello": ({ protocolVersion }) => {
      if (protocolVersion !== PROTOCOL_VERSION) {
        throw new RpcError(
          RpcErrorCode.ProtocolMismatch,
          `The daemon speaks protocol version ${PROTOCOL_VERSION}`
        );
      }

      return {
        protocolVersion: PROTOCOL_VERSION,
        wheatleyVersion: state.wheatleyVersion,
      };
    },
    "system.status": () => ({
      agents: Object.keys(state.config.agents).map(health),
      concurrency: Object.entries(state.config.providers ?? {}).map(
        ([credential, provider]) => ({
          credential,
          inUse: state.runs.filter((run) => run.status === "running").length,
          limit: provider.maxConcurrent ?? DEFAULT_GATE_LIMIT,
          waiting: 0,
        })
      ),
      protocolVersion: PROTOCOL_VERSION,
      startedAt: state.startedAt,
      uptimeMs: Math.max(0, Date.now() - Date.parse(state.startedAt)),
      version: state.wheatleyVersion,
    }),
    "triggers.create": ({ agent, trigger }) => {
      const created: Trigger = {
        conversationMode: trigger.conversationMode ?? "per_firing",
        createdAt: now(),
        createdBy: "operator",
        id: nextId("trigger"),
        lastFiredAt: null,
        name: trigger.name,
        nextFireAt:
          trigger.schedule.kind === "once" ? trigger.schedule.at : null,
        paused: trigger.paused ?? false,
        prompt: trigger.prompt,
        schedule: trigger.schedule,
        target: trigger.target,
      };

      triggersOf(agent).push(created);
      emit("trigger.changed", {
        agent,
        change: "created",
        trigger: created,
        triggerId: created.id,
      });

      return { trigger: created };
    },
    "triggers.delete": ({ agent, triggerId }) => {
      const list = triggersOf(agent);
      const index = list.findIndex((entry) => entry.id === triggerId);

      if (index === -1) {
        return { deleted: false };
      }

      list.splice(index, 1);
      emit("trigger.changed", { agent, change: "deleted", triggerId });

      return { deleted: true };
    },
    "triggers.fire": ({ agent, triggerId }) => {
      requireRunning(agent);

      const trigger = findTrigger(agent, triggerId);

      trigger.lastFiredAt = now();
      emit("trigger.changed", { agent, change: "fired", trigger, triggerId });

      return { runId: replyTo(agent, trigger.prompt).runId };
    },
    "triggers.list": ({ agent }) => ({ triggers: triggersOf(agent) }),
    "triggers.update": ({ agent, patch, triggerId }) => {
      const list = triggersOf(agent);
      const trigger = findTrigger(agent, triggerId);
      const updated: Trigger = { ...trigger, ...patch };

      list[list.indexOf(trigger)] = updated;
      emit("trigger.changed", {
        agent,
        change: "updated",
        trigger: updated,
        triggerId,
      });

      return { trigger: updated };
    },
  };

  const run = <M extends MethodName>(
    method: M,
    params: MethodParams<M>,
    connection: MockConnection
  ): MethodResult<M> => {
    const handler = overrides[method] ?? handlers[method];

    return handler(params, connection);
  };

  const handleText = (connection: MockConnection, text: string): void => {
    const decoded = decodeClientMessage(text);

    if (!decoded.ok) {
      connection.socket.send(encodeError(decoded.id, decoded.error));

      return;
    }

    const { request } = decoded;
    const queued: QueuedEvent[] = [];

    received.push(request.method);
    collecting = queued;

    try {
      const result = run(request.method, request.params, connection);

      connection.socket.send(encodeResult(request.id, request.method, result));
    } catch (error) {
      const rpcError =
        error instanceof RpcError
          ? error.toObject()
          : { code: RpcErrorCode.InternalError, message: "Internal error" };

      connection.socket.send(encodeError(request.id, rpcError));
    } finally {
      collecting = null;
    }

    for (const event of queued) {
      deliver(event);
    }
  };

  wss.on("connection", (socket: WebSocket) => {
    const connection: MockConnection = {
      id: nextId("connection"),
      socket,
      subscriptions: new Map(),
    };

    connections.add(connection);
    socket.on("message", (data: RawData) => {
      handleText(connection, rawText(data));
    });
    socket.on("close", () => {
      connections.delete(connection);
    });
  });

  return {
    close: () => {
      for (const connection of connections) {
        connection.socket.terminate();
      }

      wss.close();
    },
    connectionCount: () => connections.size,
    dropConnections: () => {
      for (const connection of connections) {
        connection.socket.terminate();
      }
    },
    editConfigExternally: (raw) => {
      const parsed = parseConfigYaml(raw);

      if (!parsed.ok) {
        throw new Error(
          `Fixture config is invalid: ${parsed.issues.map((issue) => issue.message).join(", ")}`
        );
      }

      commitConfig(parsed.config, raw, "none");
    },
    emit,
    handleUpgrade: (request, socket, head) => {
      const path = new URL(request.url ?? "/", "http://localhost").pathname;

      if (path !== SOCKET_PATH) {
        return false;
      }

      wss.handleUpgrade(request, socket, head, (client) => {
        wss.emit("connection", client, request);
      });

      return true;
    },
    override: (method, handler) => {
      Object.assign(overrides, { [method]: handler });
    },
    received,
    state,
  };
};

/** Starts a mock daemon on a free localhost port. */
export const startMockDaemon = async (
  state?: FixtureState
): Promise<ListeningMockDaemon> => {
  const daemon = createMockDaemon(state);

  const server = createServer((_request, response) => {
    response.writeHead(404).end();
  });

  server.on("upgrade", (request, socket, head) => {
    if (!daemon.handleUpgrade(request, socket, head)) {
      socket.destroy();
    }
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();

  if (!isAddressInfo(address)) {
    throw new Error("The mock daemon listens on a pipe instead of a TCP port");
  }

  const { port } = address;

  return {
    ...daemon,
    close: async () => {
      daemon.close();

      server.close();
      await once(server, "close");
    },
    url: `ws://127.0.0.1:${port}${SOCKET_PATH}`,
  };
};
