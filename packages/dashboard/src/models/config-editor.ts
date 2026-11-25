import {
  ConfigIssueSchema,
  decode,
  IdSchema,
  RpcError,
  RpcErrorCode,
} from "@wheatley/protocol";
import type {
  AgentConfig,
  ConfigIssue,
  DeploymentConfig,
  JsonObject,
  JsonValue,
  PendingRestart,
} from "@wheatley/protocol";

import type { RpcClient } from "../rpc/client.js";
import { createStore, errorMessage } from "../store.js";
import type { Store } from "../store.js";

/** `none` saves only. `affected` also restarts every changed Agent and Frontend Binding (ADR 0004). */
export type RestartMode = "none" | "affected";

/** What happens to `agents/<name>/` when an Agent is deleted. */
export type AgentDataDisposal = "keep" | "archive" | "delete";

/** One config change that the Operator asked for. A revision conflict keeps it until the Operator decides. */
export type ConfigChange =
  | {
      readonly kind: "raw";
      readonly raw: string;
      readonly restart: RestartMode;
    }
  | {
      readonly kind: "agent";
      readonly agent: string;
      readonly config: AgentConfig;
      readonly restart: RestartMode;
    }
  | {
      readonly kind: "create";
      readonly agent: string;
      readonly config: AgentConfig;
    }
  | {
      readonly kind: "rename";
      readonly agent: string;
      readonly newName: string;
    }
  | {
      readonly kind: "delete";
      readonly agent: string;
      readonly data: AgentDataDisposal;
    };

/** A save that `config.yaml` rejected because another client or a hand edit changed it first. */
export interface RevisionConflict {
  /** The current revision that the daemon reported. */
  readonly currentRevision: string | null;
  /** The change that waits for `resolveConflict`. */
  readonly change: ConfigChange;
}

/** The Config view: the loaded `config.yaml`, the raw YAML draft, and save state. */
export interface ConfigEditorState {
  readonly loading: boolean;
  readonly loadError: string | null;
  /** The revision of the loaded config, or `null` before the first load. */
  readonly revision: string | null;
  readonly config: DeploymentConfig | null;
  /** The loaded `config.yaml` text. */
  readonly raw: string;
  /** The text in the raw YAML editor. It differs from `raw` while the Operator edits. */
  readonly draft: string;
  /** Changes that wait for a restart. */
  readonly pendingRestart: readonly PendingRestart[];
  readonly saving: boolean;
  readonly saveError: string | null;
  /** Problems that `config.validate` or a rejected save reported. */
  readonly issues: readonly ConfigIssue[];
  readonly conflict: RevisionConflict | null;
  /** True if `config.yaml` changed on the daemon while the draft had unsaved edits. */
  readonly remoteChanged: boolean;
}

/** The Config model. It follows `config.changed` and reloads after each reconnect. */
export interface ConfigEditor {
  readonly state: Store<ConfigEditorState>;
  /**
   * Loads `config.yaml`. With `keepDraft`, unsaved edits in the raw editor stay. Never rejects. On failure, `loadError`
   * holds the reason.
   */
  readonly load: (keepDraft?: boolean) => Promise<void>;
  /** Replaces the raw YAML draft. */
  readonly setDraft: (draft: string) => void;
  /** Validates the draft with `config.validate` and stores its issues. Returns true if the draft is valid. */
  readonly validate: () => Promise<boolean>;
  /**
   * Applies `change` with the loaded revision as `expectedRevision`, then reloads.
   *
   * Errors: returns false instead of rejecting. A revision conflict sets `conflict` and keeps the change. An invalid
   * config sets `issues`. Any other failure sets `saveError`.
   */
  readonly save: (change: ConfigChange) => Promise<boolean>;
  /**
   * Ends a conflict. `reload` drops the waiting change and loads the current config. `overwrite` loads the current
   * revision, keeps the raw draft, and applies the waiting change on top of it: an Agent form change replaces only
   * that Agent, and a raw change replaces the whole file. Returns true if the change was saved.
   */
  readonly resolveConflict: (
    choice: "reload" | "overwrite"
  ) => Promise<boolean>;
  /** Restarts one Agent, so its pending config takes effect. Never rejects. On failure, `saveError` holds the reason. */
  readonly restartAgent: (agent: string) => Promise<void>;
  readonly dispose: () => void;
}

/** Returns true if the raw draft has unsaved edits. */
export const isDraftDirty = (state: ConfigEditorState): boolean =>
  state.draft !== state.raw;

/** Returns the pending restarts of one Agent, including those of its Frontend Bindings. */
export const pendingRestartsOf = (
  state: ConfigEditorState,
  agent: string
): readonly PendingRestart[] =>
  state.pendingRestart.filter(
    (entry) => entry.kind !== "daemon" && entry.agent === agent
  );

/** Returns a copy of `config` with `agent` set to `agentConfig`. */
export const withAgentConfig = (
  config: DeploymentConfig,
  agent: string,
  agentConfig: AgentConfig
): DeploymentConfig => ({
  ...config,
  agents: { ...config.agents, [agent]: agentConfig },
});

const isJsonObject = (value: JsonValue | undefined): value is JsonObject =>
  value instanceof Object && !Array.isArray(value);

const objectField = (
  data: JsonValue | undefined,
  field: string
): JsonValue | undefined =>
  isJsonObject(data) && Object.hasOwn(data, field) ? data[field] : undefined;

const conflictRevision = (data: JsonValue | undefined): string | null => {
  const revision = objectField(data, "revision");

  if (revision === undefined) {
    return null;
  }

  const decoded = decode(IdSchema, revision);

  return decoded.ok ? decoded.value : null;
};

const configIssues = (data: JsonValue | undefined): ConfigIssue[] => {
  const issues = objectField(data, "issues");

  if (!Array.isArray(issues)) {
    return [];
  }

  return issues.flatMap((issue: JsonValue) => {
    const decoded = decode(ConfigIssueSchema, issue);

    return decoded.ok ? [decoded.value] : [];
  });
};

/** Creates the Config model and loads it once the client is ready. */
export const createConfigEditor = (client: RpcClient): ConfigEditor => {
  const state = createStore<ConfigEditorState>({
    config: null,
    conflict: null,
    draft: "",
    issues: [],
    loadError: null,
    loading: true,
    pendingRestart: [],
    raw: "",
    remoteChanged: false,
    revision: null,
    saveError: null,
    saving: false,
  });

  const patch = (change: Partial<ConfigEditorState>): void => {
    state.update((current) => ({ ...current, ...change }));
  };

  const load = async (keepDraft = false): Promise<void> => {
    patch({ loading: true });

    try {
      const loaded = await client.call("config.get", {});

      state.update((current) => ({
        ...current,
        config: loaded.config,
        draft: keepDraft && isDraftDirty(current) ? current.draft : loaded.raw,
        loadError: null,
        loading: false,
        pendingRestart: loaded.pendingRestart,
        raw: loaded.raw,
        remoteChanged: false,
        revision: loaded.revision,
      }));
    } catch (error) {
      patch({ loadError: errorMessage(error), loading: false });
    }
  };

  /** Sends one change with `expectedRevision`. Throws the request error. */
  const apply = async (
    change: ConfigChange,
    expectedRevision: string,
    config: DeploymentConfig
  ): Promise<void> => {
    if (change.kind === "raw") {
      await client.call("config.save", {
        expectedRevision,
        raw: change.raw,
        restart: change.restart,
      });

      return;
    }

    if (change.kind === "agent") {
      await client.call("config.save", {
        config: withAgentConfig(config, change.agent, change.config),
        expectedRevision,
        restart: change.restart,
      });

      return;
    }

    if (change.kind === "create") {
      await client.call("agents.create", {
        agent: change.agent,
        config: change.config,
        expectedRevision,
      });

      return;
    }

    if (change.kind === "rename") {
      await client.call("agents.rename", {
        agent: change.agent,
        expectedRevision,
        newName: change.newName,
      });

      return;
    }

    await client.call("agents.delete", {
      agent: change.agent,
      data: change.data,
      expectedRevision,
    });
  };

  const attempt = async (
    change: ConfigChange,
    expectedRevision: string,
    config: DeploymentConfig
  ): Promise<boolean> => {
    patch({ conflict: null, issues: [], saveError: null, saving: true });

    try {
      await apply(change, expectedRevision, config);
      patch({ saving: false });
      // A raw save makes the saved text the new baseline. Other changes keep unsaved raw edits.
      await load(change.kind !== "raw");

      return true;
    } catch (error) {
      const isRpc = error instanceof RpcError;

      if (isRpc && error.code === RpcErrorCode.RevisionConflict) {
        patch({
          conflict: { change, currentRevision: conflictRevision(error.data) },
          saving: false,
        });

        return false;
      }

      if (isRpc && error.code === RpcErrorCode.ConfigInvalid) {
        patch({
          issues: configIssues(error.data),
          saveError: error.message,
          saving: false,
        });

        return false;
      }

      patch({ saveError: errorMessage(error), saving: false });

      return false;
    }
  };

  const offs = [
    client.onReady(() => {
      void load(true);
    }),
    client.on("config.changed", ({ pendingRestart, revision }) => {
      const current = state.get();

      patch({ pendingRestart });

      if (current.saving || revision === current.revision) {
        return;
      }

      if (isDraftDirty(current)) {
        patch({ remoteChanged: true });

        return;
      }

      void load();
    }),
  ];

  if (client.state.get().status === "open") {
    void load();
  }

  return {
    dispose: () => {
      for (const off of offs) {
        off();
      }
    },
    load,
    resolveConflict: async (choice) => {
      const { conflict } = state.get();

      if (conflict === null) {
        return false;
      }

      if (choice === "reload") {
        patch({ conflict: null });
        await load();

        return false;
      }

      await load(true);

      const { config, revision } = state.get();

      if (config === null || revision === null) {
        return false;
      }

      return await attempt(conflict.change, revision, config);
    },
    restartAgent: async (agent) => {
      try {
        await client.call("agents.restart", { agent });
        await load(true);
      } catch (error) {
        patch({ saveError: errorMessage(error) });
      }
    },
    save: async (change) => {
      const { config, revision } = state.get();

      if (config === null || revision === null) {
        patch({ saveError: "The config is not loaded yet." });

        return false;
      }

      return await attempt(change, revision, config);
    },
    setDraft: (draft) => {
      patch({ draft });
    },
    state,
    validate: async () => {
      try {
        const { issues, valid } = await client.call("config.validate", {
          raw: state.get().draft,
        });

        patch({ issues, saveError: null });

        return valid;
      } catch (error) {
        patch({ saveError: errorMessage(error) });

        return false;
      }
    },
  };
};
