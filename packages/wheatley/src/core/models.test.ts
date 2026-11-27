import { readFile } from "node:fs/promises";
import path from "node:path";

import type { DeploymentConfig } from "@wheatley-ai/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InMemorySecretStore } from "../contracts/secret-store.fake.js";
import { loadModelsDevCatalog, MODELS_DEV_CACHE_FILE } from "./models-dev.js";
import { createProviderModels } from "./models.js";
import { temporaryDir } from "./test-support.js";

const SAMPLE_CATALOG = {
  "custom-cloud": {
    api: "https://api.custom-cloud.example/v1",
    env: ["CUSTOM_CLOUD_API_KEY"],
    id: "custom-cloud",
    models: {
      "cloud-pro": {
        cost: { cache_read: 0.01, input: 0.5, output: 1.5 },
        id: "cloud-pro",
        limit: { context: 256_000, output: 32_000 },
        modalities: { input: ["text", "image"], output: ["text"] },
        name: "Cloud Pro",
        reasoning: true,
      },
    },
    name: "Custom Cloud",
    npm: "@ai-sdk/openai-compatible",
  },
  deepseek: {
    api: "https://api.deepseek.com",
    env: ["DEEPSEEK_API_KEY"],
    id: "deepseek",
    models: {
      "deepseek-flash": {
        cost: { cache_read: 0.003, input: 0.15, output: 0.6 },
        id: "deepseek-flash",
        limit: { context: 1_048_576, output: 393_216 },
        modalities: { input: ["text", "image"], output: ["text"] },
        name: "DeepSeek V4.1 Flash",
        reasoning: true,
      },
    },
    name: "DeepSeek",
    npm: "@ai-sdk/openai-compatible",
  },
};

let home: Awaited<ReturnType<typeof temporaryDir>>;

beforeEach(async () => {
  home = await temporaryDir();
});

afterEach(async () => {
  await home.remove();
});

describe("loadModelsDevCatalog", () => {
  it("fetches, caches, and serves fresh cache without refetching", async () => {
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json(SAMPLE_CATALOG));

    const first = await loadModelsDevCatalog({
      fetch: fetchMock,
      homeDir: home.dir,
    });

    expect(first?.findModel("deepseek", "deepseek-flash")?.contextWindow).toBe(
      1_048_576
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const cachedText = await readFile(
      path.join(home.dir, MODELS_DEV_CACHE_FILE),
      "utf-8"
    );

    expect(cachedText).toContain("deepseek-flash");

    const second = await loadModelsDevCatalog({
      fetch: fetchMock,
      homeDir: home.dir,
    });

    expect(second?.findModelById("cloud-pro")?.name).toBe("Cloud Pro");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to stale cache when offline", async () => {
    const okFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json(SAMPLE_CATALOG));

    await loadModelsDevCatalog({ fetch: okFetch, homeDir: home.dir });

    const offlineFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValue(new Error("network down"));

    const stale = await loadModelsDevCatalog({
      fetch: offlineFetch,
      homeDir: home.dir,
      ttlMs: 0,
    });

    expect(stale?.findModel("custom-cloud", "cloud-pro")?.maxTokens).toBe(
      32_000
    );
  });
});

describe("createProviderModels", () => {
  it("overrides a built-in provider protocol, baseURL, and {env:VAR} key", async () => {
    const secrets = new InMemorySecretStore({ ANTHROPIC_API_KEY: "sk-test" });

    const config: DeploymentConfig = {
      agents: { home: { model: "deepseek/deepseek-flash" } },
      provider: {
        deepseek: {
          npm: "@ai-sdk/anthropic",
          options: {
            apiKey: "{env:ANTHROPIC_API_KEY}",
            baseURL: "https://main.purroxy.org/deepseek/anthropic",
          },
        },
      },
      version: 1,
    };

    const models = await createProviderModels(config, secrets);
    const model = models.getModel("deepseek", "deepseek-flash");

    expect(model?.api).toBe("anthropic-messages");
    expect(model?.baseUrl).toBe("https://main.purroxy.org/deepseek/anthropic");
    expect(model?.compat).toBeUndefined();
    await expect(models.checkAuth("deepseek")).resolves.toBeDefined();
  });

  it("registers models.dev providers and inherits metadata for custom providers", async () => {
    const secrets = new InMemorySecretStore({
      CUSTOM_CLOUD_API_KEY: "sk-cloud",
      PROXY_KEY: "sk-proxy",
    });

    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json(SAMPLE_CATALOG));

    const config: DeploymentConfig = {
      agents: { home: { model: "my-proxy/deepseek-flash" } },
      provider: {
        "custom-cloud": {
          options: { apiKey: { secret: "CUSTOM_CLOUD_API_KEY" } },
        },
        "my-proxy": {
          models: {
            "deepseek-flash": {},
            "private-model": {
              limit: { context: 64_000, output: 8000 },
              name: "Private Model",
            },
          },
          npm: "@ai-sdk/anthropic",
          options: {
            apiKey: "{env:PROXY_KEY}",
            baseURL: "https://proxy.example/anthropic",
            headers: { "X-Proxy": "yes" },
          },
        },
      },
      version: 1,
    };

    const models = await createProviderModels(config, secrets, {
      fetch: fetchMock,
      homeDir: home.dir,
    });

    const cloudModel = models.getModel("custom-cloud", "cloud-pro");

    expect(cloudModel?.api).toBe("openai-completions");
    expect(cloudModel?.baseUrl).toBe("https://api.custom-cloud.example/v1");
    expect(cloudModel?.contextWindow).toBe(256_000);

    const inherited = models.getModel("my-proxy", "deepseek-flash");

    expect(inherited?.api).toBe("anthropic-messages");
    expect(inherited?.baseUrl).toBe("https://proxy.example/anthropic");
    expect(inherited?.contextWindow).toBe(1_048_576);
    expect(inherited?.reasoning).toBe(true);

    const privateModel = models.getModel("my-proxy", "private-model");

    expect(privateModel?.name).toBe("Private Model");
    expect(privateModel?.contextWindow).toBe(64_000);
    await expect(models.checkAuth("my-proxy")).resolves.toBeDefined();
  });

  it("rejects when a configured apiKey secret is missing", async () => {
    const config: DeploymentConfig = {
      agents: { home: { model: "deepseek/deepseek-flash" } },
      provider: {
        deepseek: {
          options: { apiKey: "{env:MISSING_KEY}" },
        },
      },
      version: 1,
    };

    await expect(
      createProviderModels(config, new InMemorySecretStore())
    ).rejects.toThrow("MISSING_KEY");
  });
});
