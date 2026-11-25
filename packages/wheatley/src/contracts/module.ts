import type { DatabaseSync } from "node:sqlite";

import type {
  EventName,
  EventPayload,
  MethodName,
  MethodParams,
  MethodResult,
} from "@wheatley-ai/protocol";
import type { Logger } from "@wheatley-ai/sdk";

import type { Migration, MigrationNamespace } from "../db/migrations.js";

/** The time source of a module. Tests pass a fake clock. */
export interface Clock {
  /** Epoch milliseconds. */
  readonly now: () => number;
}

/** The system clock. */
export const systemClock: Clock = { now: () => Date.now() };

/** Sends live events to subscribed CLI and dashboard connections. */
export interface EventSink {
  /**
   * Queues `payload` for every connection subscribed to the event's topic and Agent. Never throws and never blocks.
   *
   * Ordering: events emitted while a JSON-RPC handler runs reach that handler's connection after its response.
   */
  readonly emit: <E extends EventName>(
    name: E,
    payload: EventPayload<E>
  ) => void;
}

/** Context of one JSON-RPC request. */
export interface RpcContext {
  /** Stable for one WebSocket connection. */
  readonly connectionId: string;
  /** Aborts when the connection closes. */
  readonly signal: AbortSignal;
}

/**
 * Handles one JSON-RPC method with params that already passed the method's params schema.
 *
 * For expected failures, throw a `SeamError` or an `RpcError`. The router converts a `SeamError` with `toRpcError`.
 * It sends any other error as `InternalError` without its message. It also validates the result against the result
 * schema.
 */
export type RpcHandler<M extends MethodName> = (
  params: MethodParams<M>,
  ctx: RpcContext
) => Promise<MethodResult<M>>;

/**
 * The JSON-RPC methods that one module instance handles.
 *
 * Routing rules for the Wave 2 router:
 * - An Agent module instance receives only requests whose `params.agent` names its Agent.
 * - For a method with an optional `agent` param, such as `approvals.list`, a request without `agent` goes to every
 *   running Agent's instance with `agent` set, and the router concatenates the array fields of the results.
 * - Two modules must not handle the same method.
 */
export type RpcHandlerMap = { readonly [M in MethodName]?: RpcHandler<M> };

/** What every module instance gets from the Agent that hosts it. */
export interface AgentModuleContext {
  readonly agentName: string;
  /** `~/.wheatley/agents/<name>/`, or `/data/agents/<name>/` in Docker. */
  readonly agentDir: string;
  /** The open `agent.sqlite` handle, with every module's migrations applied. Do not close it. */
  readonly db: DatabaseSync;
  readonly log: Logger;
  readonly clock: Clock;
  readonly events: EventSink;
}

/** What every Deployment module instance gets from the Deployment. */
export interface DeploymentModuleContext {
  /** `~/.wheatley/`, or `/data/` in Docker. */
  readonly homeDir: string;
  readonly log: Logger;
  readonly clock: Clock;
  readonly events: EventSink;
}

/**
 * A created module: its API for other modules, its JSON-RPC handlers, and its lifecycle. The host is the Agent or the
 * Deployment that created the module.
 */
export interface ModuleInstance<Api> {
  readonly api: Api;
  readonly rpc: RpcHandlerMap;
  /** Starts background work such as timers or connections. The host calls it once, after it creates every module. */
  readonly start?: () => Promise<void>;
  /**
   * Stops background work. The host calls it once, in reverse creation order. It must resolve, also after a failed
   * `start`.
   */
  readonly stop?: () => Promise<void>;
}

/**
 * The entry point that each Agent-scoped Wave 1 track exports, so that Wave 2 wiring is mechanical:
 *
 * 1. The Agent runs `migrations` of all modules (namespace `name`) on `agent.sqlite` before any `create`.
 * 2. It calls `create` with the shared context and the module's own dependencies.
 * 3. It mounts `rpc`, then calls `start`.
 */
export interface AgentModule<Deps, Api> {
  readonly scope: "agent";
  /** The module name and its migration namespace, for example `memory`. Matches `^[a-z][a-z0-9_]{0,31}$`. */
  readonly name: string;
  readonly migrations: readonly Migration[];
  /**
   * Creates the module instance. The Agent calls it once, after it applies the migrations of all modules and before it
   * calls any `start`. It must not start background work, because `start` does that.
   *
   * Errors: it throws or rejects if the module cannot set up, for example for invalid `deps`. The Agent then does not
   * mount the module and enters the `degraded` state (see `IngressAgent.triggers`).
   */
  readonly create: (
    ctx: AgentModuleContext,
    deps: Deps
  ) => Promise<ModuleInstance<Api>> | ModuleInstance<Api>;
}

/** The entry point of a Deployment-scoped Wave 1 track, for example the Webhook Ingress. */
export interface DeploymentModule<Deps, Api> {
  readonly scope: "deployment";
  readonly name: string;
  /**
   * Creates the module instance. The Deployment calls it once, when it starts. It must not start background work,
   * because `start` does that.
   *
   * Errors: it throws or rejects if the module cannot set up, for example for invalid `deps`. The Deployment then
   * logs the error through `ctx.log`, does not mount the module, and keeps the Control Server and every Agent running.
   */
  readonly create: (
    ctx: DeploymentModuleContext,
    deps: Deps
  ) => Promise<ModuleInstance<Api>> | ModuleInstance<Api>;
}

/** Returns the migration namespace of an Agent module for `runMigrations`. */
export const migrationNamespace = <Deps, Api>(
  module: AgentModule<Deps, Api>
): MigrationNamespace => ({
  migrations: module.migrations,
  namespace: module.name,
});
