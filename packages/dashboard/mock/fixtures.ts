import type {
  AvailableModel,
  AgentState,
  ChatMessage,
  ConsolidationLogEntry,
  DeploymentConfig,
  FailedDelivery,
  LogRecord,
  ModelRef,
  PendingApproval,
  PendingRestart,
  RunSummary,
  RunTimelineItem,
  SecretInfo,
  SecretSource,
  SkillInfo,
  ToolInfo,
  Trigger,
} from "@wheatley-ai/protocol";
import { stringify } from "yaml";

import { DEFAULT_MEMORY_MAX_CHARS } from "../src/models/config-editor.js";

/** The Supervisor view of one Agent in the fixture. */
export interface FixtureAgentRuntime {
  state: AgentState;
  lastError: string | null;
  restartBackoffMs: number | null;
}

/** One stored secret in the fixture. */
export interface FixtureSecret {
  value: string;
  source: SecretSource;
  references: SecretInfo["references"];
}

/** One Memory file in the fixture. */
export interface FixtureMemoryFile {
  content: string;
  updatedAt: string;
}

/** The complete mutable state of the mock daemon. Tests read and change it directly. */
export interface FixtureState {
  wheatleyVersion: string;
  startedAt: string;
  revision: number;
  raw: string;
  config: DeploymentConfig;
  pendingRestart: PendingRestart[];
  runtime: Map<string, FixtureAgentRuntime>;
  approvals: PendingApproval[];
  deliveries: FailedDelivery[];
  secrets: Map<string, FixtureSecret>;
  logs: LogRecord[];
  runs: RunSummary[];
  timelines: Map<string, RunTimelineItem[]>;
  conversations: Map<string, string>;
  /** The model of each Agent's CLI Chat Conversation after `/model`. Without an entry, the configured model. */
  chatModels: Map<string, ModelRef>;
  chat: Map<string, ChatMessage[]>;
  memory: Map<string, Map<string, FixtureMemoryFile>>;
  memoryMaxChars: number;
  consolidation: Map<string, ConsolidationLogEntry[]>;
  triggers: Map<string, Trigger[]>;
  tools: ToolInfo[];
  skills: SkillInfo[];
  nextId: number;
}

const MINUTE_MS = 60_000;

/** Returns the `config.yaml` text of a config, with the header comment that a hand-written file has. */
export const configToYaml = (config: DeploymentConfig): string =>
  `# Wheatley Deployment config\n${stringify(config)}`;

const at = (now: number, minutesAgo: number): string =>
  new Date(now - minutesAgo * MINUTE_MS).toISOString();

const fixtureConfig = (): DeploymentConfig => ({
  agents: {
    home: {
      approvalTimeout: "15m",
      frontends: [
        {
          config: {
            allowedChatIds: ["1001"],
            token: { secret: "TELEGRAM_TOKEN" },
          },
          id: "telegram",
          type: "telegram",
        },
      ],
      instructions: "You help with the household.",
      mcpServers: {
        github: {
          headers: { Authorization: { secret: "GITHUB_TOKEN" } },
          transport: "http",
          url: "https://api.githubcopilot.com/mcp/",
        },
      },
      memory: { maxChars: DEFAULT_MEMORY_MAX_CHARS },
      model: { id: "claude-sonnet-4-5", provider: "anthropic" },
      permissionPolicy: [
        { action: "allow", tool: "read_file" },
        { action: "ask", tool: "shell" },
      ],
      plugins: [{ source: "./plugins/notes" }],
    },
    work: {
      model: {
        id: "claude-sonnet-4-5",
        provider: "anthropic",
        thinking: "low",
      },
    },
  },
  providers: { anthropic: { apiKey: { secret: "ANTHROPIC_API_KEY" } } },
  version: 1,
});

/** The models that `models.list` returns, sorted by provider, then by model ID. */
export const FIXTURE_MODELS: readonly AvailableModel[] = [
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", provider: "anthropic" },
  { id: "claude-opus-4-5", name: "Claude Opus 4.5", provider: "anthropic" },
  {
    id: "claude-sonnet-4-5",
    name: "Claude Sonnet 4.5",
    provider: "anthropic",
  },
  { id: "gpt-5", name: "GPT-5", provider: "openai" },
  { id: "gpt-5-mini", name: "GPT-5 mini", provider: "openai" },
];

/** Creates the seed state of the mock daemon at time `now` (epoch milliseconds). */
export const createFixtureState = (now: number): FixtureState => {
  const config = fixtureConfig();

  const waitingRun: RunSummary = {
    agent: "home",
    conversationId: "conv-home",
    endedAt: null,
    origin: { bindingId: "telegram", chatId: "1001", kind: "chat" },
    runId: "run-2",
    startedAt: at(now, 2),
    status: "waiting_approval",
  };

  const finishedRun: RunSummary = {
    agent: "home",
    conversationId: "conv-cli-home",
    endedAt: at(now, 29),
    model: "claude-sonnet-4-5",
    origin: { bindingId: "cli", chatId: "default", kind: "chat" },
    runId: "run-1",
    startedAt: at(now, 30),
    status: "completed",
    usage: { costUsd: 0.0042, inputTokens: 1200, outputTokens: 180 },
  };

  return {
    approvals: [
      {
        agent: "home",
        approvalId: "approval-1",
        chat: { bindingId: "telegram", chatId: "1001" },
        conversationId: "conv-home",
        createdAt: at(now, 2),
        expiresAt: at(now, -13),
        inputPreview: '{"command":"ls -la ~/Downloads"}',
        runId: "run-2",
        toolName: "shell",
      },
    ],
    chat: new Map([
      [
        "home",
        [
          {
            at: at(now, 30),
            messageId: "msg-1",
            role: "user",
            senderDisplayName: "Operator",
            text: "What is on my calendar today?",
          },
          {
            at: at(now, 29),
            messageId: "msg-2",
            role: "assistant",
            runId: "run-1",
            source: "reply",
            text: "You have a dentist appointment at 15:00.",
          },
        ],
      ],
      ["work", []],
    ]),
    chatModels: new Map(),
    config,
    consolidation: new Map([
      [
        "home",
        [
          {
            endedAt: at(now, 600),
            id: "consolidation-1",
            runId: "run-0",
            startedAt: at(now, 601),
            status: "completed",
            summary: "Merged 3 facts into MEMORY.md.",
          },
        ],
      ],
    ]),
    conversations: new Map([
      ["home", "conv-cli-home"],
      ["work", "conv-cli-work"],
    ]),
    deliveries: [
      {
        agent: "home",
        attempts: 5,
        bindingId: "telegram",
        chatId: "1001",
        createdAt: at(now, 45),
        deliveryId: "delivery-1",
        failedAt: at(now, 40),
        kind: "message",
        lastError: "ETIMEDOUT api.telegram.org",
        permanent: false,
        preview: "Your package arrives tomorrow.",
      },
    ],
    logs: [
      {
        at: at(now, 3),
        level: "info",
        message: "Agent started",
        module: "supervisor",
        seq: 1,
        agent: "home",
      },
      {
        at: at(now, 2),
        level: "warn",
        message: "Delivery failed, will not retry",
        module: "outbox",
        seq: 2,
        agent: "home",
        fields: { deliveryId: "delivery-1" },
      },
    ],
    memory: new Map([
      [
        "home",
        new Map([
          [
            "MEMORY",
            {
              content: "- The Operator prefers short answers.\n",
              updatedAt: at(now, 600),
            },
          ],
          [
            "groceries",
            { content: "Oat milk, apples.\n", updatedAt: at(now, 120) },
          ],
        ]),
      ],
      ["work", new Map<string, FixtureMemoryFile>()],
    ]),
    memoryMaxChars: DEFAULT_MEMORY_MAX_CHARS,
    nextId: 100,
    pendingRestart: [],
    raw: configToYaml(config),
    revision: 1,
    runs: [waitingRun, finishedRun],
    runtime: new Map([
      ["home", { lastError: null, restartBackoffMs: null, state: "running" }],
      ["work", { lastError: null, restartBackoffMs: null, state: "running" }],
    ]),
    secrets: new Map([
      [
        "ANTHROPIC_API_KEY",
        {
          references: [{ id: "anthropic", kind: "provider" }],
          source: "file",
          value: "sk-ant-fixture-key",
        },
      ],
      [
        "GITHUB_TOKEN",
        {
          references: [{ agent: "home", id: "github", kind: "mcp" }],
          source: "env",
          value: "ghp_fixture_token",
        },
      ],
      [
        "TELEGRAM_TOKEN",
        {
          references: [{ agent: "home", id: "telegram", kind: "frontend" }],
          source: "file",
          value: "123456:fixture-telegram-token",
        },
      ],
    ]),
    skills: [
      {
        description: "Plans the weekly grocery list.",
        name: "groceries",
        origin: "agent",
        path: "agents/home/skills/groceries",
      },
    ],
    startedAt: at(now, 90),
    timelines: new Map([
      [
        "run-1",
        [
          {
            at: at(now, 30),
            kind: "user_message",
            senderDisplayName: "Operator",
            text: "What is on my calendar today?",
          },
          {
            endedAt: at(now, 30),
            inputPreview: '{"day":"today"}',
            kind: "tool_call",
            outputPreview: "15:00 Dentist",
            startedAt: at(now, 30),
            toolCallId: "call-1",
            toolName: "mcp:calendar:list_events",
          },
          {
            at: at(now, 29),
            kind: "assistant_text",
            text: "You have a dentist appointment at 15:00.",
          },
        ],
      ],
      [
        "run-2",
        [
          {
            at: at(now, 2),
            kind: "user_message",
            text: "Clean up my downloads folder.",
          },
          {
            approvalId: "approval-1",
            at: at(now, 2),
            kind: "approval",
            toolName: "shell",
          },
        ],
      ],
    ]),
    tools: [
      {
        action: "allow",
        description: "Reads a file.",
        name: "read_file",
        source: "builtin",
      },
      {
        action: "ask",
        description: "Runs a shell command.",
        name: "shell",
        source: "builtin",
      },
      {
        action: "ask",
        description: "Adds a note.",
        name: "notes:add",
        source: "plugin",
      },
    ],
    triggers: new Map([
      [
        "home",
        [
          {
            conversationMode: "shared",
            createdAt: at(now, 1440),
            createdBy: "operator",
            id: "trigger-1",
            lastFiredAt: at(now, 600),
            name: "Morning brief",
            nextFireAt: at(now, -240),
            paused: false,
            prompt: "Summarize my day.",
            schedule: {
              kind: "cron",
              schedule: "0 7 * * *",
              timezone: "Europe/Berlin",
            },
            target: { bindingId: "telegram", chatId: "1001" },
          },
        ],
      ],
      ["work", []],
    ]),
    wheatleyVersion: "1.0.0-fixture",
  };
};
