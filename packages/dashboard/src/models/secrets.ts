import type { SecretInfo } from "@wheatley-ai/protocol";

import type { RpcClient } from "../rpc/client.js";
import { createStore, errorMessage, withEntry, withMember } from "../store.js";
import type { Store } from "../store.js";
import { loadOnReady } from "./lifecycle.js";

/** The Secrets view: secret names with their sources and references, and the values the Operator revealed. */
export interface SecretsState {
  readonly loading: boolean;
  readonly error: string | null;
  /** Secrets sorted by name. The list never holds values. */
  readonly secrets: readonly SecretInfo[];
  /** Plaintext values that the Operator revealed, by name. Only this page's memory holds them. */
  readonly revealed: ReadonlyMap<string, string>;
  /** Names with a request in flight. */
  readonly busy: ReadonlySet<string>;
  /** The last failed request of each secret, by name. */
  readonly itemErrors: ReadonlyMap<string, string>;
}

/** The Secrets model. */
export interface Secrets {
  readonly state: Store<SecretsState>;
  /** Loads the secret list again. Never rejects. On failure, `error` holds the reason. Keeps revealed values. */
  readonly refresh: () => Promise<void>;
  /**
   * Fetches one plaintext value with `secrets.reveal` and keeps it in `revealed` until `hide`, `set`, or `remove`.
   * Never rejects. On failure, the item error holds the reason.
   */
  readonly reveal: (name: string) => Promise<void>;
  /** Forgets a revealed value. */
  readonly hide: (name: string) => void;
  /**
   * Adds or rotates a secret, forgets its revealed value, and reloads the list.
   *
   * Errors: rejects with the request error, so a form can keep its input.
   */
  readonly set: (name: string, value: string) => Promise<void>;
  /** Deletes a secret from `secrets.yaml` and reloads the list. Never rejects. */
  readonly remove: (name: string) => Promise<void>;
  /** Removes the reconnect listener. Revealed values stay in `state` until the page drops the model. */
  readonly dispose: () => void;
}

/** The text that the Secrets view shows in place of a value that is not revealed. */
export const MASKED_VALUE = "••••••••";

/** Creates the Secrets model and loads it once the client is ready. */
export const createSecrets = (client: RpcClient): Secrets => {
  const state = createStore<SecretsState>({
    busy: new Set(),
    error: null,
    itemErrors: new Map(),
    loading: true,
    revealed: new Map(),
    secrets: [],
  });

  const setBusy = (name: string, busy: boolean): void => {
    state.update((current) => ({
      ...current,
      busy: withMember(current.busy, name, busy),
    }));
  };

  const setItemError = (name: string, error?: string): void => {
    state.update((current) => ({
      ...current,
      itemErrors: withEntry(current.itemErrors, name, error),
    }));
  };

  const forget = (name: string): void => {
    state.update((current) => ({
      ...current,
      revealed: withEntry(current.revealed, name, undefined),
    }));
  };

  const refresh = async (): Promise<void> => {
    state.update((current) => ({ ...current, loading: true }));

    try {
      const { secrets } = await client.call("secrets.list", {});

      state.update((current) => ({
        ...current,
        error: null,
        loading: false,
        secrets: secrets.toSorted((left, right) =>
          left.name.localeCompare(right.name)
        ),
      }));
    } catch (error) {
      state.update((current) => ({
        ...current,
        error: errorMessage(error),
        loading: false,
      }));
    }
  };

  const dispose = loadOnReady(client, () => {
    void refresh();
  });

  return {
    dispose,
    hide: forget,
    refresh,
    remove: async (name) => {
      setBusy(name, true);
      setItemError(name);

      try {
        await client.call("secrets.delete", { name });
        forget(name);
        await refresh();
      } catch (error) {
        setItemError(name, errorMessage(error));
      } finally {
        setBusy(name, false);
      }
    },
    reveal: async (name) => {
      setBusy(name, true);
      setItemError(name);

      try {
        const { value } = await client.call("secrets.reveal", { name });

        state.update((current) => ({
          ...current,
          revealed: withEntry(current.revealed, name, value),
        }));
      } catch (error) {
        setItemError(name, errorMessage(error));
      } finally {
        setBusy(name, false);
      }
    },
    set: async (name, value) => {
      setBusy(name, true);

      try {
        await client.call("secrets.set", { name, value });
        forget(name);
        setItemError(name);
        await refresh();
      } finally {
        setBusy(name, false);
      }
    },
    state,
  };
};
