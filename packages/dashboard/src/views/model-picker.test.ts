// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { startHarness } from "../../mock/harness.js";
import type { Harness } from "../../mock/harness.js";
import { ServicesContext } from "../hooks.js";
import { createConfigEditor } from "../models/config-editor.js";
import { createDeployment } from "../models/deployment.js";
import { createInbox } from "../models/inbox.js";
import { createLogTail } from "../models/logs.js";
import { createSecrets } from "../models/secrets.js";
import type { RpcClient } from "../rpc/client.js";
import { ModelPicker } from "./model-picker.js";

const AGENT = "home";

let harness: Harness;
let root: Root | undefined;

beforeEach(async () => {
  harness = await startHarness();
});

afterEach(async () => {
  root?.unmount();
  document.body.replaceChildren();
  await harness.close();
});

/** Renders the picker of `AGENT` against the mock daemon and returns the client that it uses. */
const renderPicker = async (): Promise<RpcClient> => {
  const client = await harness.connect();

  const services = {
    client,
    config: createConfigEditor(client),
    deployment: createDeployment(client),
    inbox: createInbox(client),
    logs: createLogTail(client),
    secrets: createSecrets(client),
  };

  const container = document.createElement("div");

  document.body.append(container);
  root = createRoot(container);
  root.render(
    createElement(
      ServicesContext,
      { value: services },
      createElement(ModelPicker, { agent: AGENT })
    )
  );

  return client;
};

const trigger = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[aria-label="Model"]');

/** Waits until the picker shows `text` as the chosen model. */
const expectShown = async (text: string): Promise<void> => {
  await vi.waitFor(() => {
    expect(trigger()?.textContent).toContain(text);
  });
};

const lastChatText = async (client: RpcClient): Promise<string | undefined> => {
  const { messages } = await client.call("chat.history", { agent: AGENT });

  return messages.at(-1)?.text;
};

test("switches the CLI Chat model to the chosen model", async () => {
  const client = await renderPicker();

  await expectShown("Claude Sonnet 4.5");
  act(() => {
    trigger()?.click();
  });

  const option = await vi.waitFor(() => {
    const found = [
      ...document.querySelectorAll<HTMLElement>('[role="option"]'),
    ].find((element) => element.textContent?.includes("gpt-5-mini"));

    expect(found).toBeDefined();

    return found;
  });

  act(() => {
    option?.click();
  });

  await expectShown("GPT-5 mini");
  expect(await client.call("models.list", { agent: AGENT })).toMatchObject({
    current: { id: "gpt-5-mini", provider: "openai" },
  });
  expect(await lastChatText(client)).toBe(
    "This Conversation now uses openai/gpt-5-mini."
  );
});

test("shows a model that the composer switched to, also after /new", async () => {
  const client = await renderPicker();

  await expectShown("Claude Sonnet 4.5");
  await client.call("chat.command", {
    agent: AGENT,
    args: "openai/gpt-5",
    name: "model",
  });
  await expectShown("GPT-5");
  await client.call("chat.command", { agent: AGENT, name: "new" });

  expect(await client.call("models.list", { agent: AGENT })).toMatchObject({
    current: { id: "gpt-5", provider: "openai" },
  });
  await expectShown("GPT-5");
});

test("keeps the model if the Agent rejects an unknown model", async () => {
  const client = await renderPicker();

  await expectShown("Claude Sonnet 4.5");

  expect(
    await client.call("chat.command", {
      agent: AGENT,
      args: "openai/unknown",
      name: "model",
    })
  ).toEqual({ accepted: false });
  expect(await lastChatText(client)).toBe("Unknown model: openai/unknown");
  await expectShown("Claude Sonnet 4.5");
});

test("asks to start the Agent after it stops", async () => {
  const client = await renderPicker();

  await expectShown("Claude Sonnet 4.5");
  await client.call("agents.stop", { agent: AGENT });

  await vi.waitFor(() => {
    expect(document.body.textContent).toContain(
      "Start the Agent to choose a model."
    );
  });
});
