import type { DeploymentConfig } from "@wheatley/protocol";
import { describe, expect, it } from "vitest";

import { InMemoryConfigStore } from "./config-store.fake.js";
import type { ConfigSnapshot } from "./config-store.js";
import { SeamError } from "./errors.js";
import { InMemorySecretStore } from "./secret-store.fake.js";

const config: DeploymentConfig = {
  agents: { home: { model: { id: "faux-1", provider: "faux" } } },
  version: 1,
};

const catchSeamError = async (
  run: () => Promise<ConfigSnapshot>
): Promise<SeamError> => {
  try {
    await run();
  } catch (error) {
    if (error instanceof SeamError) {
      return error;
    }

    throw error;
  }

  throw new Error("Expected a SeamError");
};

describe("InMemoryConfigStore", () => {
  it("rejects a save with a stale revision and reports the current one", async () => {
    const store = new InMemoryConfigStore(config);
    const { revision } = await store.read();
    await store.save(
      { config: { ...config, webhooks: { enabled: true } } },
      revision
    );

    const error = await catchSeamError(
      async () => await store.save({ config }, revision)
    );

    const current = await store.read();

    expect(error.code).toBe("revision_conflict");
    expect(error.details).toStrictEqual({ revision: current.revision });
  });

  it("rejects an invalid config and keeps the file", async () => {
    const store = new InMemoryConfigStore(config);
    const before = await store.read();

    const error = await catchSeamError(
      async () => await store.save({ raw: '{"version": 2}' }, before.revision)
    );

    expect(error.code).toBe("config_invalid");
    expect(await store.read()).toStrictEqual(before);
    expect(await store.validate('{"version": 1, "agents": {}}')).toStrictEqual(
      []
    );
  });

  it("prepends a permission rule once", async () => {
    const store = new InMemoryConfigStore(config);
    const rule = { action: "allow", tool: "shell" } as const;

    await store.prependPermissionRule("home", rule);
    const { config: saved } = await store.prependPermissionRule("home", rule);

    expect(saved.agents.home?.permissionPolicy).toStrictEqual([rule]);

    const error = await catchSeamError(
      async () => await store.prependPermissionRule("nobody", rule)
    );

    expect(error.code).toBe("agent_not_found");
  });
});

describe("InMemorySecretStore", () => {
  it("lets environment values win and reports both sources", async () => {
    const secrets = new InMemorySecretStore(
      { BOT_TOKEN: "from-file" },
      { BOT_TOKEN: "from-env" }
    );

    expect(secrets.get("BOT_TOKEN")).toBe("from-env");
    await expect(secrets.list()).resolves.toStrictEqual([
      { name: "BOT_TOKEN", references: [], source: "both" },
    ]);
  });

  it("redacts every secret value, longest first", () => {
    const secrets = new InMemorySecretStore({
      LONG: "abcdefgh",
      SHORT: "abcd",
    });

    expect(secrets.redact("key=abcdefgh other=abcd")).toBe(
      "key=[redacted] other=[redacted]"
    );
  });
});
