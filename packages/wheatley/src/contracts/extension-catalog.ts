import type {
  AgentConfig,
  ExtensionStatus,
  JsonValue,
  PermissionAction,
  SkillInfo,
  ToolSource,
} from "@wheatley/protocol";
import type {
  Frontend,
  JsonSchema,
  Logger,
  SecretReader,
  ToolContext,
  ToolResult,
} from "@wheatley/sdk";

/** A Tool as the Agent offers it to the model. */
export interface ToolDescriptor {
  /** The canonical name from `canonicalToolName`. */
  readonly name: string;
  readonly description: string;
  /** Plain JSON Schema for the model provider. Standard JSON Schema input is converted at load time. */
  readonly inputSchema: JsonSchema;
  readonly source: ToolSource;
  /** The action when no Permission Policy rule matches: the built-in default, or `ask` for Plugin and MCP Tools. */
  readonly defaultAction: PermissionAction;
}

/**
 * A set of Tools from one source: the built-in Tools, the Plugins of an Agent, its MCP Servers, or its Skills
 * (`read_skill`). The Plugins, MCP, and Skills tracks each export a factory that returns one.
 */
export interface ToolProvider {
  /** The Tools that loaded. A failed Plugin or MCP Server contributes none and reports in `health`. */
  readonly tools: () => readonly ToolDescriptor[];
  /**
   * Runs a Tool after the Permission Policy allowed it. Validates `input` against the Tool's schema first.
   *
   * Resolves `{ isError: true }` for an unknown Tool, invalid input, a throw from the Tool, or an abort of
   * `ctx.signal`. Never rejects.
   */
  readonly execute: (
    name: string,
    input: JsonValue,
    ctx: ToolContext
  ) => Promise<ToolResult>;
  /** Load and connection status of each Plugin or MCP Server of this provider. */
  readonly health: () => readonly ExtensionStatus[];
  /** Releases Plugin instances and closes MCP connections. Called once when the Agent stops. */
  readonly close: () => Promise<void>;
}

/** The Skills part of an Agent's extensions. */
export interface SkillProvider extends ToolProvider {
  readonly skills: () => readonly SkillInfo[];
  /** The Tier 1 catalog text for the system prompt: one line per Skill with its name and description. */
  readonly catalogPrompt: () => string;
  /** Problems with `SKILL.md` files that the provider skipped. */
  readonly warnings: () => readonly string[];
}

/** The Plugins part of an Agent's extensions. */
export interface PluginProvider extends ToolProvider {
  /** Frontends that loaded Plugins contribute, by `type`. */
  readonly frontends: () => readonly Frontend[];
}

/** Input of a provider factory. */
export interface ProviderInput {
  readonly agentName: string;
  readonly agentDir: string;
  readonly config: AgentConfig;
  readonly secrets: SecretReader;
  readonly log: Logger;
  /** Aborts when the Agent stops during loading. */
  readonly signal: AbortSignal;
}

/** Every extension of one Agent, merged. */
export interface AgentExtensions {
  /** All Tools, in the order built-in, Plugins, MCP, Skills. Canonical names are unique. */
  readonly tools: () => readonly ToolDescriptor[];
  readonly skills: () => readonly SkillInfo[];
  readonly skillCatalogPrompt: () => string;
  /** Frontends by `type`: the built-in Telegram, Slack, and Discord Frontends plus Plugin Frontends. */
  readonly frontends: () => ReadonlyMap<string, Frontend>;
  readonly health: () => {
    readonly plugins: readonly ExtensionStatus[];
    readonly mcpServers: readonly ExtensionStatus[];
    readonly skillWarnings: readonly string[];
  };
  /** Runs a Tool by canonical name with the semantics of `ToolProvider.execute`. Never rejects. */
  readonly executeTool: (
    name: string,
    input: JsonValue,
    ctx: ToolContext
  ) => Promise<ToolResult>;
  /** Closes every provider, also if one of them fails to close. */
  readonly close: () => Promise<void>;
}

/** Creates the extensions of each Agent (ADR 0006). Agents share no extension instances. */
export interface ExtensionCatalog {
  /**
   * Loads the Plugins, MCP Servers, and Skills of one Agent. Never rejects because of one broken extension: the
   * Agent starts without it, and `health` reports the error.
   */
  readonly createAgentExtensions: (
    input: ProviderInput
  ) => Promise<AgentExtensions>;
}
