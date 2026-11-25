import { isDeepStrictEqual } from "node:util";

import type {
  AgentConfig,
  DeploymentConfig,
  PendingRestart,
  ProviderConfig,
} from "@wheatley/protocol";

/** The settings that one running Agent started with. */
export interface AppliedAgent {
  readonly config: AgentConfig;
  /** The settings of the Agent's model provider. */
  readonly provider: ProviderConfig | undefined;
}

/** The config that each running Agent and the daemon started with. */
export interface AppliedConfig {
  /** The settings of each running Agent at its start. */
  readonly agents: ReadonlyMap<string, AppliedAgent>;
  /** The config file that the daemon started with. */
  readonly daemon: DeploymentConfig;
}

const withoutFrontends = (
  config: AgentConfig
): Omit<AgentConfig, "frontends"> => {
  const { frontends: _frontends, ...rest } = config;

  return rest;
};

const bindingChanges = (
  agent: string,
  applied: AgentConfig,
  next: AgentConfig
): PendingRestart[] => {
  const before = new Map(
    (applied.frontends ?? []).map((binding) => [binding.id, binding])
  );

  const after = new Map(
    (next.frontends ?? []).map((binding) => [binding.id, binding])
  );

  const ids = [...new Set([...before.keys(), ...after.keys()])].toSorted();

  return ids.flatMap((bindingId): PendingRestart[] =>
    isDeepStrictEqual(before.get(bindingId), after.get(bindingId))
      ? []
      : [{ agent, bindingId, kind: "binding" }]
  );
};

/**
 * Lists the changes of `next` that wait for a restart (ADR 0004):
 * - `agent` for a running Agent whose settings other than `frontends`, or whose model provider's settings, changed.
 * - `binding` for each added, removed, or changed Frontend Binding of a running Agent whose other settings stayed.
 * - `daemon` if the Control Server or Webhook Ingress settings changed.
 *
 * An Agent that is not running has nothing pending: its next start reads `config.yaml`.
 */
export const pendingRestarts = (
  applied: AppliedConfig,
  next: DeploymentConfig
): PendingRestart[] => {
  const pending: PendingRestart[] = [];

  for (const [agent, { config: before, provider }] of [
    ...applied.agents.entries(),
  ].toSorted(([left], [right]) => left.localeCompare(right))) {
    const after = next.agents[agent];

    if (after === undefined) {
      continue;
    }

    const providerChanged = !isDeepStrictEqual(
      provider,
      next.providers?.[after.model.provider]
    );

    if (
      providerChanged ||
      !isDeepStrictEqual(withoutFrontends(before), withoutFrontends(after))
    ) {
      pending.push({ agent, kind: "agent" });
    } else {
      pending.push(...bindingChanges(agent, before, after));
    }
  }

  if (!isDeepStrictEqual(applied.daemon.daemon, next.daemon)) {
    pending.push({
      kind: "daemon",
      reason: "The Control Server settings changed",
    });
  }

  if (!isDeepStrictEqual(applied.daemon.webhooks, next.webhooks)) {
    pending.push({
      kind: "daemon",
      reason: "The Webhook Ingress settings changed",
    });
  }

  return pending;
};
