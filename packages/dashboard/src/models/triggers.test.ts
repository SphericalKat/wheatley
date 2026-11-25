import type { Trigger } from "@wheatley/protocol";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { startHarness } from "../../mock/harness.js";
import type { Harness } from "../../mock/harness.js";
import { createConfigEditor } from "./config-editor.js";
import { webhookEndpoint } from "./triggers.js";

let harness: Harness;

beforeEach(async () => {
  harness = await startHarness();
});

afterEach(async () => {
  await harness.close();
});

/** Creates a webhook Trigger through the daemon and returns it with the `webhooks` block of `config.get`. */
const webhookTriggerAndConfig = async () => {
  const client = await harness.connect();

  const { trigger } = await client.call("triggers.create", {
    agent: "home",
    trigger: {
      name: "Deploy hook",
      prompt: "A deploy finished.",
      schedule: { kind: "webhook", tokenSecret: "HOOK_TOKEN" },
      target: { bindingId: "cli", chatId: "default" },
    },
  });

  const editor = createConfigEditor(client);

  await vi.waitFor(() => {
    expect(editor.state.get().config).not.toBeNull();
  });

  return {
    trigger: trigger satisfies Trigger,
    webhooks: editor.state.get().config?.webhooks,
  };
};

test("gives the POST path and the default listener URL of a webhook Trigger", async () => {
  harness.daemon.state.config = {
    ...harness.daemon.state.config,
    webhooks: { enabled: true },
  };

  const { trigger, webhooks } = await webhookTriggerAndConfig();

  expect(webhookEndpoint("home", trigger.id, webhooks)).toEqual({
    path: `/webhooks/home/${trigger.id}`,
    url: `http://127.0.0.1:8788/webhooks/home/${trigger.id}`,
  });
});

test("uses the configured webhook host and port in the URL", async () => {
  harness.daemon.state.config = {
    ...harness.daemon.state.config,
    webhooks: { enabled: true, host: "::1", port: 9000 },
  };

  const { trigger, webhooks } = await webhookTriggerAndConfig();

  expect(webhookEndpoint("home", trigger.id, webhooks).url).toBe(
    `http://[::1]:9000/webhooks/home/${trigger.id}`
  );
});

test("gives no URL while the Webhook Ingress is off", async () => {
  const { trigger, webhooks } = await webhookTriggerAndConfig();

  expect(webhookEndpoint("home", trigger.id, webhooks)).toEqual({
    path: `/webhooks/home/${trigger.id}`,
    url: null,
  });
});
