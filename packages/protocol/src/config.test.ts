import {
  decode,
  DeploymentConfigSchema,
  TriggerInputSchema,
} from "@wheatley-ai/protocol";
import { describe, expect, it } from "vitest";

const validConfig = {
  agents: {
    home: {
      approvalTimeout: null,
      frontends: [
        {
          config: { allowedChatIds: ["123"] },
          id: "telegram-main",
          type: "telegram",
        },
      ],
      mcpServers: {
        github: {
          command: "github-mcp",
          env: { TOKEN: { secret: "GITHUB_TOKEN" } },
          transport: "stdio",
        },
      },
      model: "anthropic/claude-sonnet-5",
      permissionPolicy: [
        { action: "allow", tool: "read_file" },
        { action: "ask", tool: "mcp:github:*" },
      ],
    },
  },
  provider: {
    anthropic: {
      options: {
        apiKey: { secret: "ANTHROPIC_API_KEY" },
        maxConcurrent: 2,
      },
    },
  },
  version: 1,
  webhooks: { enabled: true, port: 8787 },
};

describe("DeploymentConfigSchema", () => {
  it("accepts a complete config", () => {
    expect(decode(DeploymentConfigSchema, validConfig)).toStrictEqual({
      ok: true,
      value: validConfig,
    });
  });

  it("rejects an Agent name that is not a valid folder name", () => {
    const decoded = decode(DeploymentConfigSchema, {
      ...validConfig,
      agents: { "Bad Name": validConfig.agents.home },
    });

    expect(decoded.ok).toBe(false);
  });

  it("rejects a raw secret value where a secret reference is required", () => {
    const decoded = decode(DeploymentConfigSchema, {
      ...validConfig,
      provider: { anthropic: { options: { apiKey: "sk-live-value" } } },
    });

    expect(decoded).toMatchObject({ ok: false });
  });

  it("accepts OpenCode-style custom providers, {env:VAR} api keys, and model overrides", () => {
    const decoded = decode(DeploymentConfigSchema, {
      ...validConfig,
      agents: {
        home: {
          ...validConfig.agents.home,
          model: "deepseek/deepseek-flash",
          thinking: "medium",
        },
      },
      provider: {
        deepseek: {
          models: {
            "deepseek-flash": {
              limit: { context: 1_000_000, output: 384_000 },
              name: "DeepSeek Flash",
              reasoning: true,
            },
          },
          name: "DeepSeek via Purroxy",
          npm: "@ai-sdk/anthropic",
          options: {
            apiKey: "{env:ANTHROPIC_API_KEY}",
            baseURL: "https://main.purroxy.org/deepseek/anthropic",
          },
        },
      },
    });

    expect(decoded.ok).toBe(true);
  });

  it("rejects unknown fields so typos fail validation", () => {
    const decoded = decode(DeploymentConfigSchema, {
      ...validConfig,
      agentz: {},
    });

    expect(decoded).toMatchObject({ ok: false });
  });

  it("accepts rules for MCP Tool names with uppercase letters, dots, and hyphens", () => {
    const decoded = decode(DeploymentConfigSchema, {
      ...validConfig,
      agents: {
        home: {
          ...validConfig.agents.home,
          permissionPolicy: [
            { action: "allow", tool: "mcp:context7:resolve-library-id" },
            { action: "ask", tool: "mcp:github:getIssue" },
            { action: "deny", tool: "mcp:browser:browser.*" },
          ],
        },
      },
    });

    expect(decoded.ok).toBe(true);
  });

  it("rejects an unsupported config version", () => {
    expect(
      decode(DeploymentConfigSchema, { ...validConfig, version: 2 })
    ).toMatchObject({ ok: false });
  });
});

const webhookTrigger = (tokenSecret: string) => ({
  name: "CI",
  prompt: "Summarize",
  schedule: { kind: "webhook", tokenSecret },
  target: { bindingId: "tg", chatId: "1" },
});

describe("TriggerInputSchema", () => {
  it("accepts a webhook token secret only with a valid secret name", () => {
    expect(decode(TriggerInputSchema, webhookTrigger("HOOK_TOKEN")).ok).toBe(
      true
    );
    expect(decode(TriggerInputSchema, webhookTrigger("my-token")).ok).toBe(
      false
    );
  });
});
