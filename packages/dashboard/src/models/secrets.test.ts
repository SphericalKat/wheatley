import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { startHarness } from "../../mock/harness.js";
import type { Harness } from "../../mock/harness.js";
import { createSecrets } from "./secrets.js";
import type { Secrets } from "./secrets.js";

let harness: Harness;

beforeEach(async () => {
  harness = await startHarness();
});

afterEach(async () => {
  await harness.close();
});

const loadedSecrets = async (): Promise<Secrets> => {
  const secrets = createSecrets(await harness.connect());

  await vi.waitFor(() => {
    expect(secrets.state.get().loading).toBe(false);
  });

  return secrets;
};

test("lists secret names and references without values", async () => {
  const secrets = await loadedSecrets();
  const { revealed, secrets: list } = secrets.state.get();

  expect(list.map((secret) => secret.name)).toEqual([
    "ANTHROPIC_API_KEY",
    "GITHUB_TOKEN",
    "TELEGRAM_TOKEN",
  ]);
  expect(JSON.stringify(list)).not.toContain("fixture");
  expect(revealed.size).toBe(0);
  expect(harness.daemon.received).not.toContain("secrets.reveal");
});

test("reveals one value on demand and hides it again", async () => {
  const secrets = await loadedSecrets();

  await secrets.reveal("GITHUB_TOKEN");

  expect([...secrets.state.get().revealed]).toEqual([
    ["GITHUB_TOKEN", "ghp_fixture_token"],
  ]);
  expect(
    harness.daemon.received.filter((method) => method === "secrets.reveal")
  ).toHaveLength(1);

  secrets.hide("GITHUB_TOKEN");

  expect(secrets.state.get().revealed.size).toBe(0);
});

test("records a failed reveal on the secret", async () => {
  const secrets = await loadedSecrets();

  harness.daemon.state.secrets.delete("GITHUB_TOKEN");
  await secrets.reveal("GITHUB_TOKEN");

  expect(secrets.state.get().revealed.size).toBe(0);
  expect(secrets.state.get().itemErrors.get("GITHUB_TOKEN")).toBe(
    "No secret GITHUB_TOKEN"
  );
  expect(secrets.state.get().busy.size).toBe(0);
});

test("forgets a revealed value after a rotation and lists new secrets", async () => {
  const secrets = await loadedSecrets();

  await secrets.reveal("TELEGRAM_TOKEN");
  await secrets.set("TELEGRAM_TOKEN", "rotated");
  await secrets.set("SLACK_TOKEN", "xoxb-new");

  expect(secrets.state.get().revealed.has("TELEGRAM_TOKEN")).toBe(false);
  expect(secrets.state.get().secrets.map((secret) => secret.name)).toContain(
    "SLACK_TOKEN"
  );

  await secrets.reveal("TELEGRAM_TOKEN");

  expect(secrets.state.get().revealed.get("TELEGRAM_TOKEN")).toBe("rotated");
});

test("deletes a secret", async () => {
  const secrets = await loadedSecrets();

  await secrets.remove("GITHUB_TOKEN");

  expect(secrets.state.get().secrets.map((secret) => secret.name)).toEqual([
    "ANTHROPIC_API_KEY",
    "TELEGRAM_TOKEN",
  ]);
  expect(harness.daemon.state.secrets.has("GITHUB_TOKEN")).toBe(false);
});
