import type {
  EventName,
  EventPayload,
  MethodName,
  MethodParams,
  MethodResult,
} from "@wheatley/protocol";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import type { ConfigEditor } from "./models/config-editor.js";
import type { Deployment } from "./models/deployment.js";
import type { Inbox } from "./models/inbox.js";
import type { LogTail } from "./models/logs.js";
import type { Secrets } from "./models/secrets.js";
import type { RpcClient } from "./rpc/client.js";
import { errorMessage } from "./store.js";
import type { Store } from "./store.js";

/** The client and the Deployment-wide models that every view shares. */
export interface Services {
  readonly client: RpcClient;
  readonly deployment: Deployment;
  readonly inbox: Inbox;
  readonly secrets: Secrets;
  readonly config: ConfigEditor;
  readonly logs: LogTail;
}

export const ServicesContext = createContext<Services | null>(null);

/** Returns the shared services. Throws outside `ServicesContext`. */
export const useServices = (): Services => {
  const services = useContext(ServicesContext);

  if (services === null) {
    throw new Error("useServices needs a ServicesContext provider");
  }

  return services;
};

/** Returns the current state of a store and renders again on each change. */
export const useStore = <State>(store: Store<State>): State =>
  useSyncExternalStore(store.subscribe, store.get);

/** Returns the Agent that an event is about, or `undefined` for a Deployment-wide event. */
export const eventAgent = (
  payload: EventPayload<EventName>
): string | undefined => {
  if ("agent" in payload) {
    return payload.agent;
  }

  return "record" in payload ? payload.record.agent : undefined;
};

/**
 * Calls `listener` for each `name` event while the component is mounted. The latest `listener` runs, so it can read
 * current props without a new subscription.
 */
export const useEvent = <E extends EventName>(
  name: E,
  listener: (payload: EventPayload<E>) => void
): void => {
  const { client } = useServices();
  const latest = useRef(listener);

  latest.current = listener;

  useEffect(
    () =>
      client.on(name, (payload) => {
        latest.current(payload);
      }),
    [client, name]
  );
};

/** The state of one `useRpcQuery`. */
export interface QueryState<Result> {
  readonly data: Result | null;
  readonly error: string | null;
  readonly loading: boolean;
  /** Sends the request again. */
  readonly refresh: () => void;
}

/** Settings of `useRpcQuery`. */
export interface QueryOptions {
  /** Events that make the query reload, for example `trigger.changed`. */
  readonly refreshOn?: readonly EventName[];
  /** With `refreshOn`, reload only for events about this Agent or about no Agent. */
  readonly agent?: string;
  /** Skips the request while false. */
  readonly enabled?: boolean;
}

/**
 * Sends one request while the component is mounted, and again after a reconnect, a change of `params`, or a
 * `refreshOn` event. A response that arrives after a newer request started is dropped.
 */
export const useRpcQuery = <M extends MethodName>(
  method: M,
  params: MethodParams<M>,
  options: QueryOptions = {}
): QueryState<MethodResult<M>> => {
  const { client } = useServices();
  const [data, setData] = useState<MethodResult<M> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [generation, setGeneration] = useState(0);
  const key = JSON.stringify(params);
  const latestParams = useRef(params);
  const { agent, enabled = true, refreshOn = [] } = options;
  const eventsKey = refreshOn.join(",");

  latestParams.current = params;

  const refresh = useCallback(() => {
    setGeneration((current) => current + 1);
  }, []);

  useEffect(() => {
    let current = true;

    const load = async (): Promise<void> => {
      setLoading(true);

      try {
        const result = await client.call(method, latestParams.current);

        if (current) {
          setData(result);
          setError(null);
        }
      } catch (error_) {
        if (current) {
          setError(errorMessage(error_));
        }
      } finally {
        if (current) {
          setLoading(false);
        }
      }
    };

    if (enabled) {
      void load();
    }

    return () => {
      current = false;
    };
  }, [client, method, key, generation, enabled]);

  useEffect(() => {
    const offs = [client.onReady(refresh)];

    for (const name of refreshOn) {
      offs.push(
        client.on(name, (payload) => {
          const about = eventAgent(payload);

          if (agent === undefined || about === undefined || about === agent) {
            refresh();
          }
        })
      );
    }

    return () => {
      for (const off of offs) {
        off();
      }
    };
    // `eventsKey` stands for `refreshOn`, so a new array with the same events keeps the subscriptions.
  }, [client, eventsKey, agent, refresh]);

  return { data, error, loading, refresh };
};
