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
      model: { id: "claude-sonnet-5", provider: "anthropic" },
      permissionPolicy: [
        { action: "allow", tool: "read_file" },
        { action: "ask", tool: "mcp:github:*" },
      ],
    },
  },
  providers: {
    anthropic: { apiKey: { secret: "ANTHROPIC_API_KEY" }, maxConcurrent: 2 },
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
      providers: { anthropic: { apiKey: "sk-live-value" } },
    });

    expect(decoded).toMatchObject({ ok: false });
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
