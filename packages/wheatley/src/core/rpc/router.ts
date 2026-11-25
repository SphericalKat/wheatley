import {
  decode,
  isJsonValue,
  METHOD_NAMES,
  methods,
  RpcError,
  RpcErrorCode,
} from "@wheatley/protocol";
import type {
  JsonObject,
  JsonValue,
  MethodName,
  MethodParams,
  MethodResult,
} from "@wheatley/protocol";

import type {
  RpcContext,
  RpcHandler,
  RpcHandlerMap,
} from "../../contracts/module.js";

/** Where the router finds handlers. */
export interface RouterSources {
  /** Deployment-wide handler maps. The router checks them first. */
  readonly deployment: readonly RpcHandlerMap[];
  /**
   * The handler maps of one Agent. If the Agent is starting, stopping, or restarting, it waits for a limited time for
   * that call to finish. Rejects at once with `SeamError("agent_not_found")` for an unknown Agent. Rejects with
   * `SeamError("agent_unavailable")` if the Agent is not running after the wait, for example `degraded`, `stopped`, or
   * still `starting` when the wait limit ends.
   */
  readonly agent: (name: string) => Promise<readonly RpcHandlerMap[]>;
  /** The names of the running Agents, for methods whose `agent` param is optional. */
  readonly runningAgents: () => readonly string[];
}

/** One decoded request whose params match its method. */
export interface RoutedRequest<M extends MethodName> {
  readonly method: M;
  readonly params: MethodParams<M>;
}

const handlerIn = <M extends MethodName>(
  maps: readonly RpcHandlerMap[],
  method: M
): RpcHandler<M> | undefined => {
  for (const map of maps) {
    const handler: RpcHandler<M> | undefined = map[method];

    if (handler !== undefined) {
      return handler;
    }
  }

  return undefined;
};

/** True if the params name an Agent, so the request goes to that Agent's handlers. */
const namesAgent = <M extends MethodName>(
  params: MethodParams<M>
): params is MethodParams<M> & { readonly agent: string } =>
  "agent" in params && typeof params.agent === "string";

const isObject = (value: JsonValue): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** True if a params schema has an `agent` property that is not required. */
const hasOptionalAgent = (schema: JsonValue): boolean => {
  if (
    !isObject(schema) ||
    schema.properties === undefined ||
    !isObject(schema.properties)
  ) {
    return false;
  }

  const { required } = schema;

  return (
    schema.properties.agent !== undefined &&
    !(Array.isArray(required) && required.includes("agent"))
  );
};

/**
 * The methods whose `agent` param is optional, such as `approvals.list`. A request without `agent` goes to every
 * running Agent.
 */
const FAN_OUT_METHODS: ReadonlySet<MethodName> = new Set(
  METHOD_NAMES.filter((method) => {
    const schema: unknown = structuredClone(methods[method].params);

    return isJsonValue(schema) && hasOptionalAgent(schema);
  })
);

const isJsonArray = (
  value: JsonValue | undefined
): value is readonly JsonValue[] => Array.isArray(value);

/** True if `value` matches the result schema of `method`. */
const isResultOf = <M extends MethodName>(
  method: M,
  value: JsonObject | MethodResult<M>
): value is MethodResult<M> =>
  isJsonValue(value) && decode(methods[method].result, value).ok;

/** Merges the results of one method from several Agents: arrays concatenate, booleans combine with OR. */
const mergeResults = (results: readonly JsonObject[]): JsonObject => {
  const merged: Record<string, JsonValue> = {};

  for (const result of results) {
    for (const [key, value] of Object.entries(result)) {
      const previous = merged[key];

      if (isJsonArray(value) && isJsonArray(previous)) {
        merged[key] = [...previous, ...value];
      } else if (value === true || previous === undefined) {
        merged[key] = value;
      }
    }
  }

  return merged;
};

/**
 * Routes JSON-RPC requests to module handlers (see `RpcHandlerMap` for the rules):
 * 1. A Deployment-wide handler of the method.
 * 2. With `params.agent`, the handler of that Agent's modules.
 * 3. Without `params.agent`, for a method whose `agent` param is optional, every running Agent that handles it. The
 *    router sets `agent` on each call and merges the results.
 *
 * Errors: throws `RpcError` `MethodNotFound` if no module handles the method, and passes handler errors through.
 */
export const createRouter = (sources: RouterSources) => {
  const fanOut = async <M extends MethodName>(
    request: RoutedRequest<M>,
    ctx: RpcContext
  ): Promise<MethodResult<M>> => {
    const handlers = await Promise.all(
      sources.runningAgents().map(async (name) => ({
        handler: handlerIn(await sources.agent(name), request.method),
        name,
      }))
    );

    const calls = handlers.flatMap(({ handler, name }) =>
      handler === undefined ? [] : [{ handler, name }]
    );

    const results = await Promise.all(
      calls.map(
        async ({ handler, name }) =>
          await handler({ ...request.params, agent: name }, ctx)
      )
    );

    const objects = results.flatMap((result): JsonObject[] =>
      isJsonValue(result) && isObject(result) ? [result] : []
    );

    const merged = mergeResults(objects);

    if (!isResultOf(request.method, merged)) {
      throw new RpcError(RpcErrorCode.InternalError, "Internal error");
    }

    return merged;
  };

  return {
    /** Runs the handler of one request and resolves with its result. */
    dispatch: async <M extends MethodName>(
      request: RoutedRequest<M>,
      ctx: RpcContext
    ): Promise<MethodResult<M>> => {
      const deploymentHandler = handlerIn(sources.deployment, request.method);

      if (deploymentHandler !== undefined) {
        return await deploymentHandler(request.params, ctx);
      }

      if (namesAgent(request.params)) {
        const handler = handlerIn(
          await sources.agent(request.params.agent),
          request.method
        );

        if (handler === undefined) {
          throw new RpcError(
            RpcErrorCode.MethodNotFound,
            `Method not available: ${request.method}`
          );
        }

        return await handler(request.params, ctx);
      }

      if (!FAN_OUT_METHODS.has(request.method)) {
        throw new RpcError(
          RpcErrorCode.MethodNotFound,
          `Method not available: ${request.method}`
        );
      }

      return await fanOut(request, ctx);
    },
  };
};

/** The router that `createRouter` returns. */
export type Router = ReturnType<typeof createRouter>;
