import type { AgentConfig, DeploymentConfig } from "@wheatley/protocol";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { configToYaml } from "../../mock/fixtures.js";
import { startHarness } from "../../mock/harness.js";
import type { Harness } from "../../mock/harness.js";
import {
  createConfigEditor,
  isDraftDirty,
  pendingRestartsOf,
} from "./config-editor.js";
import type { ConfigEditor } from "./config-editor.js";

let harness: Harness;

beforeEach(async () => {
  harness = await startHarness();
});

afterEach(async () => {
  await harness.close();
});

const loadedEditor = async (): Promise<ConfigEditor> => {
  const editor = createConfigEditor(await harness.connect());

  await vi.waitFor(() => {
    expect(editor.state.get().revision).not.toBeNull();
  });

  return editor;
};

const daemonConfig = (): DeploymentConfig => harness.daemon.state.config;

const withWorkModel = (
  config: DeploymentConfig,
  id: string
): DeploymentConfig => {
  const { work } = config.agents;

  if (work === undefined) {
    throw new Error("The fixture has no work Agent");
  }

  return {
    ...config,
    agents: {
      ...config.agents,
      work: { ...work, model: { ...work.model, id } },
    },
  };
};

const homeConfig = (editor: ConfigEditor): AgentConfig => {
  const home = editor.state.get().config?.agents.home;

  if (home === undefined) {
    throw new Error("The fixture has no home Agent");
  }

  return home;
};

test("loads the config, its raw YAML, and its revision", async () => {
  const editor = await loadedEditor();

  expect(editor.state.get()).toMatchObject({
    config: daemonConfig(),
    draft: harness.daemon.state.raw,
    loadError: null,
    raw: harness.daemon.state.raw,
    revision: "rev-1",
  });
  expect(isDraftDirty(editor.state.get())).toBe(false);
});

test("saves the raw draft and marks the changed Agent as waiting for a restart", async () => {
  const editor = await loadedEditor();
  const draft = configToYaml(withWorkModel(daemonConfig(), "claude-opus-4-5"));

  editor.setDraft(draft);

  expect(isDraftDirty(editor.state.get())).toBe(true);
  expect(await editor.save({ kind: "raw", raw: draft, restart: "none" })).toBe(
    true
  );

  expect(harness.daemon.state.raw).toBe(draft);
  expect(editor.state.get()).toMatchObject({
    draft,
    raw: draft,
    revision: "rev-2",
  });
  expect(pendingRestartsOf(editor.state.get(), "work")).toEqual([
    { agent: "work", kind: "agent" },
  ]);
});

test("Save & Restart restarts the changed Agent, so nothing waits for a restart", async () => {
  const editor = await loadedEditor();
  const config = { ...homeConfig(editor), instructions: "Be brief." };

  expect(
    await editor.save({
      agent: "home",
      config,
      kind: "agent",
      restart: "affected",
    })
  ).toBe(true);

  expect(harness.daemon.state.config.agents.home?.instructions).toBe(
    "Be brief."
  );
  expect(editor.state.get().pendingRestart).toEqual([]);
});

test("clears a pending restart after the Operator restarts the Agent", async () => {
  const editor = await loadedEditor();

  await editor.save({
    agent: "home",
    config: { ...homeConfig(editor), maxConcurrentRuns: 2 },
    kind: "agent",
    restart: "none",
  });

  expect(pendingRestartsOf(editor.state.get(), "home")).toHaveLength(1);

  await editor.restartAgent("home");

  await vi.waitFor(() => {
    expect(pendingRestartsOf(editor.state.get(), "home")).toEqual([]);
  });
});

test("keeps a raw draft and reports a conflict when config.yaml changed underneath it", async () => {
  const editor = await loadedEditor();
  const draft = configToYaml(withWorkModel(daemonConfig(), "mine"));
  const external = configToYaml(withWorkModel(daemonConfig(), "theirs"));

  editor.setDraft(draft);
  harness.daemon.editConfigExternally(external);

  await vi.waitFor(() => {
    expect(editor.state.get().remoteChanged).toBe(true);
  });

  expect(await editor.save({ kind: "raw", raw: draft, restart: "none" })).toBe(
    false
  );
  expect(editor.state.get()).toMatchObject({
    conflict: { change: { kind: "raw", raw: draft }, currentRevision: "rev-2" },
    draft,
    saving: false,
  });
  expect(harness.daemon.state.raw).toBe(external);
});

test("overwrites the newer file with the raw draft if the Operator chooses so", async () => {
  const editor = await loadedEditor();
  const draft = configToYaml(withWorkModel(daemonConfig(), "mine"));

  editor.setDraft(draft);
  harness.daemon.editConfigExternally(
    configToYaml(withWorkModel(daemonConfig(), "theirs"))
  );
  await editor.save({ kind: "raw", raw: draft, restart: "none" });

  expect(await editor.resolveConflict("overwrite")).toBe(true);
  expect(harness.daemon.state.raw).toBe(draft);
  expect(editor.state.get()).toMatchObject({
    conflict: null,
    draft,
    raw: draft,
    revision: "rev-3",
  });
});

test("drops the raw draft and loads the newer file if the Operator reloads", async () => {
  const editor = await loadedEditor();
  const external = configToYaml(withWorkModel(daemonConfig(), "theirs"));

  editor.setDraft(configToYaml(withWorkModel(daemonConfig(), "mine")));
  harness.daemon.editConfigExternally(external);
  await editor.save({
    kind: "raw",
    raw: editor.state.get().draft,
    restart: "none",
  });

  expect(await editor.resolveConflict("reload")).toBe(false);
  expect(editor.state.get()).toMatchObject({
    conflict: null,
    draft: external,
    raw: external,
    remoteChanged: false,
    revision: "rev-2",
  });
});

test("re-applies an Agent form change on top of a newer config without losing the other edit", async () => {
  const editor = await loadedEditor();
  const home = { ...homeConfig(editor), instructions: "Mine" };

  harness.daemon.editConfigExternally(
    configToYaml(withWorkModel(daemonConfig(), "theirs"))
  );

  const saved = await editor.save({
    agent: "home",
    config: home,
    kind: "agent",
    restart: "none",
  });

  expect(saved).toBe(false);
  expect(editor.state.get().conflict?.change.kind).toBe("agent");
  expect(await editor.resolveConflict("overwrite")).toBe(true);
  expect(daemonConfig().agents.home?.instructions).toBe("Mine");
  expect(daemonConfig().agents.work?.model.id).toBe("theirs");
});

test("reloads by itself when config.yaml changes and the draft has no edits", async () => {
  const editor = await loadedEditor();
  const external = configToYaml(withWorkModel(daemonConfig(), "theirs"));

  harness.daemon.editConfigExternally(external);

  await vi.waitFor(() => {
    expect(editor.state.get()).toMatchObject({
      draft: external,
      revision: "rev-2",
    });
  });
});

test("reports the issues of an invalid raw save", async () => {
  const editor = await loadedEditor();
  const draft = "version: 2\nagents: {}\n";

  editor.setDraft(draft);

  expect(await editor.validate()).toBe(false);
  expect(editor.state.get().issues[0]?.path).toBe("/version");
  expect(await editor.save({ kind: "raw", raw: draft, restart: "none" })).toBe(
    false
  );
  expect(editor.state.get().issues[0]?.path).toBe("/version");
  expect(harness.daemon.state.revision).toBe(1);
});

test("creates, renames, and deletes Agents with the loaded revision", async () => {
  const editor = await loadedEditor();
  const config = { model: { id: "claude-haiku-4-5", provider: "anthropic" } };

  expect(await editor.save({ agent: "lab", config, kind: "create" })).toBe(
    true
  );
  expect(
    await editor.save({ agent: "lab", kind: "rename", newName: "garage" })
  ).toBe(true);
  expect(Object.keys(daemonConfig().agents)).toEqual([
    "home",
    "work",
    "garage",
  ]);
  expect(
    await editor.save({ agent: "garage", data: "archive", kind: "delete" })
  ).toBe(true);
  expect(Object.keys(editor.state.get().config?.agents ?? {})).toEqual([
    "home",
    "work",
  ]);
  expect(editor.state.get().revision).toBe("rev-4");
});

test("keeps an Agent rename that conflicts until the Operator decides", async () => {
  const editor = await loadedEditor();

  harness.daemon.editConfigExternally(
    configToYaml(withWorkModel(daemonConfig(), "theirs"))
  );

  expect(
    await editor.save({ agent: "work", kind: "rename", newName: "office" })
  ).toBe(false);
  expect(daemonConfig().agents.work).toBeDefined();
  expect(await editor.resolveConflict("overwrite")).toBe(true);
  expect(daemonConfig().agents.office?.model.id).toBe("theirs");
});
