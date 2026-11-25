import { createRequire } from "node:module";
import path from "node:path";

import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import type {
  JsonSchemaType,
  JsonSchemaValidator,
  Tool as McpTool,
  Transport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import { isJsonValue } from "@wheatley/protocol";
import type {
  ExtensionState,
  ExtensionStatus,
  JsonObject,
  JsonValue,
  McpServerConfig,
  SecretRef,
  StringOrSecret,
} from "@wheatley/protocol";
import type { Logger, SecretReader, ToolResult } from "@wheatley/sdk";

import type { ToolDescriptor } from "../contracts/extension-catalog.js";
import { canonicalToolName } from "../contracts/tool-names.js";
import { errorResult, isJsonObject, toToolResult } from "./content.js";

/** Time limits of one MCP Server connection. */
export interface McpTimeouts {
  /** The limit for the connect handshake and the first `tools/list`, in milliseconds. */
  readonly connectMs: number;
  /**
   * The SDK limit for one `tools/call`, in milliseconds. The Agent's own Tool timeout aborts `ToolContext.signal`
   * earlier, so this limit only stops a call that the Agent never aborts.
   */
  readonly callMs: number;
}

/** What one MCP Server connection needs from its Agent. */
export interface McpServerInput {
  readonly name: string;
  readonly config: McpServerConfig;
  readonly agentDir: string;
  readonly secrets: SecretReader;
  readonly log: Logger;
  readonly timeouts: McpTimeouts;
}

interface McpToolEntry {
  readonly descriptor: ToolDescriptor;
  /** The name that the server reported, which `tools/call` uses. */
  readonly remoteName: string;
  readonly definition: McpTool;
  readonly validate: JsonSchemaValidator<unknown>;
}

interface PackageManifest {
  readonly version: string;
}

const isPackageManifest = (value: unknown): value is PackageManifest =>
  typeof value === "object" &&
  value !== null &&
  "version" in value &&
  typeof value.version === "string";

const readPackageVersion = (): string => {
  // The package root is two levels up from both `src/mcp/` and `dist/mcp/`.
  const manifest: unknown = createRequire(import.meta.url)(
    "../../package.json"
  );

  return isPackageManifest(manifest) ? manifest.version : "0.0.0";
};

const CLIENT_INFO = { name: "wheatley", version: readPackageVersion() };

type InputSchema = McpTool["inputSchema"];

/**
 * True if the input schema of an MCP Tool holds only JSON values. AJV checks the JSON Schema keywords when
 * `getValidator` compiles the document, and throws for a schema that it cannot compile.
 */
const isJsonSchemaDocument = (
  schema: InputSchema
): schema is InputSchema & JsonObject & JsonSchemaType => isJsonValue(schema);

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const isSecretRef = (value: StringOrSecret): value is SecretRef =>
  typeof value !== "string";

const resolveValue = (value: StringOrSecret, secrets: SecretReader): string => {
  if (!isSecretRef(value)) {
    return value;
  }

  const secret = secrets.get(value.secret);

  if (secret === undefined) {
    throw new Error(`Unknown secret: ${value.secret}`);
  }

  return secret;
};

/** Resolves the `{ secret }` references of stdio `env` or HTTP `headers`. Throws for an unknown secret. */
const resolveValues = (
  values: Readonly<Record<string, StringOrSecret>> | undefined,
  secrets: SecretReader
) =>
  Object.fromEntries(
    Object.entries(values ?? {}).map(([key, value]) => [
      key,
      resolveValue(value, secrets),
    ])
  );

/**
 * One MCP Server of one Agent: its client, its Tools, and its status.
 *
 * A failure of this server changes only its own status and Tools. Every method except `connect` never throws.
 */
export class McpServerConnection {
  readonly name: string;
  readonly #input: McpServerInput;
  readonly #validator = new AjvJsonSchemaValidator();
  #state: ExtensionState;
  #error: string | undefined;
  #client: Client | undefined;
  #tools: ReadonlyMap<string, McpToolEntry> = new Map();

  constructor(input: McpServerInput) {
    this.name = input.name;
    this.#input = input;
    this.#state = input.config.enabled === false ? "disabled" : "starting";
  }

  /** The Tools of this server while it is `ready`, otherwise none. */
  readonly tools = (): readonly ToolDescriptor[] =>
    this.#state === "ready"
      ? [...this.#tools.values()].map((entry) => entry.descriptor)
      : [];

  /** True if `name` is a canonical Tool name of this server. Matches also while the server is not `ready`. */
  readonly owns = (name: string): boolean => this.#tools.has(name);

  readonly status = (): ExtensionStatus =>
    this.#error === undefined
      ? { name: this.name, state: this.#state }
      : { error: this.#error, name: this.name, state: this.#state };

  /**
   * Connects the client with protocol version negotiation `auto`, then lists the Tools.
   *
   * Resolves after the server is `ready` or `failed`. Never rejects. A disabled server stays `disabled` and starts no
   * process. Call it at most once. `signal` aborts the connect and fails the server.
   */
  readonly connect = async (signal: AbortSignal): Promise<void> => {
    if (this.#state !== "starting") {
      return;
    }

    try {
      const client = new Client(CLIENT_INFO, {
        jsonSchemaValidator: this.#validator,
        listChanged: {
          tools: {
            onChanged: (error, tools) => {
              this.#onToolsChanged(error, tools);
            },
          },
        },
        versionNegotiation: { mode: "auto" },
      });

      // oxlint-disable-next-line unicorn/prefer-add-event-listener -- The MCP SDK Protocol exposes only `onerror`.
      client.onerror = (error) => {
        this.#input.log.warn("MCP Server error", {
          error: error.message,
          server: this.name,
        });
      };

      // oxlint-disable-next-line unicorn/prefer-add-event-listener -- The MCP SDK Protocol exposes only `onclose`.
      client.onclose = () => {
        this.#onClose();
      };

      this.#client = client;

      await client.connect(this.#createTransport(), {
        signal,
        timeout: this.#input.timeouts.connectMs,
      });

      const { tools } = await client.listTools(undefined, {
        signal,
        timeout: this.#input.timeouts.connectMs,
      });

      if (this.#state !== "starting") {
        return;
      }

      this.#tools = this.#indexTools(tools);
      this.#state = "ready";
      this.#input.log.info("MCP Server connected", {
        server: this.name,
        tools: this.#tools.size,
      });
    } catch (error) {
      this.#fail(errorMessage(error));
      await this.#closeClient();
    }
  };

  /**
   * Runs one Tool of this server. Validates `input` against the Tool's input schema before the call.
   *
   * Resolves `{ isError: true }` for an unknown Tool, a server that is not `ready`, invalid input, an error from the
   * server, or an abort of `signal`. Never rejects.
   */
  readonly execute = async (
    name: string,
    input: JsonValue,
    signal: AbortSignal
  ): Promise<ToolResult> => {
    const entry = this.#tools.get(name);
    const client = this.#client;

    if (entry === undefined) {
      return errorResult(`Unknown Tool: ${name}`);
    }

    if (this.#state !== "ready" || client === undefined) {
      return errorResult(
        `MCP Server ${this.name} is not available: ${this.#error ?? this.#state}`
      );
    }

    const validation = entry.validate(input);

    if (!validation.valid || !isJsonObject(input)) {
      return errorResult(
        `Invalid input for ${name}: ${validation.errorMessage ?? "input must be an object"}`
      );
    }

    if (signal.aborted) {
      return errorResult(`${name} was aborted`);
    }

    try {
      const result = await client.callTool(
        { arguments: input, name: entry.remoteName },
        {
          signal,
          timeout: this.#input.timeouts.callMs,
          toolDefinition: entry.definition,
        }
      );

      return toToolResult(result);
    } catch (error) {
      return signal.aborted
        ? errorResult(`${name} was aborted`)
        : errorResult(`${name} failed: ${errorMessage(error)}`);
    }
  };

  /**
   * Closes the client and, for stdio, ends the server process. The state becomes `stopped`, except for `disabled`.
   *
   * Call it after `connect` settles. Never rejects.
   */
  readonly close = async (): Promise<void> => {
    if (this.#state !== "disabled") {
      this.#state = "stopped";
      this.#error = undefined;
    }

    await this.#closeClient();
  };

  readonly #closeClient = async (): Promise<void> => {
    const client = this.#client;

    this.#client = undefined;

    try {
      await client?.close();
    } catch (error) {
      this.#input.log.warn("MCP Server close failed", {
        error: errorMessage(error),
        server: this.name,
      });
    }
  };

  readonly #fail = (message: string): void => {
    if (this.#state === "stopped" || this.#state === "disabled") {
      return;
    }

    this.#state = "failed";
    this.#error = message;
    this.#input.log.warn("MCP Server failed", {
      error: message,
      server: this.name,
    });
  };

  readonly #onClose = (): void => {
    if (this.#state === "ready") {
      this.#fail("Connection closed");
    }
  };

  readonly #onToolsChanged = (
    error: Error | null,
    tools: McpTool[] | null
  ): void => {
    if (error !== null) {
      this.#input.log.warn("MCP Tool list refresh failed", {
        error: error.message,
        server: this.name,
      });

      return;
    }

    if (tools !== null && this.#state === "ready") {
      this.#tools = this.#indexTools(tools);
      this.#input.log.info("MCP Tool list changed", {
        server: this.name,
        tools: this.#tools.size,
      });
    }
  };

  readonly #createTransport = (): Transport => {
    const { agentDir, config, secrets } = this.#input;

    if (config.transport === "http") {
      return new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: { headers: resolveValues(config.headers, secrets) },
      });
    }

    const transport = new StdioClientTransport({
      args: [...(config.args ?? [])],
      command: config.command,
      cwd:
        config.cwd === undefined
          ? undefined
          : path.resolve(agentDir, config.cwd),
      env: resolveValues(config.env, secrets),
      stderr: "pipe",
    });

    transport.stderr?.on("data", (chunk: Buffer | string) => {
      this.#input.log.debug("MCP Server stderr", {
        server: this.name,
        text: chunk.toString(),
      });
    });

    return transport;
  };

  /** Builds the canonical Tool index. Skips Tools with invalid names, duplicate names, or unusable input schemas. */
  readonly #indexTools = (
    tools: readonly McpTool[]
  ): ReadonlyMap<string, McpToolEntry> => {
    const index = new Map<string, McpToolEntry>();

    for (const tool of tools) {
      const entry = this.#toEntry(tool);

      if (entry === undefined) {
        continue;
      }

      if (index.has(entry.descriptor.name)) {
        this.#skipTool(tool.name, "duplicate Tool name");
        continue;
      }

      index.set(entry.descriptor.name, entry);
    }

    return index;
  };

  readonly #toEntry = (tool: McpTool): McpToolEntry | undefined => {
    const { inputSchema } = tool;

    if (!isJsonSchemaDocument(inputSchema)) {
      this.#skipTool(tool.name, "input schema is not JSON");

      return undefined;
    }

    try {
      const name = canonicalToolName(
        { kind: "mcp", server: this.name },
        tool.name
      );

      return {
        definition: tool,
        descriptor: {
          defaultAction: "ask",
          description: tool.description ?? tool.title ?? "",
          inputSchema,
          name,
          source: "mcp",
        },
        remoteName: tool.name,
        validate: this.#validator.getValidator(inputSchema),
      };
    } catch (error) {
      this.#skipTool(tool.name, errorMessage(error));

      return undefined;
    }
  };

  readonly #skipTool = (tool: string, reason: string): void => {
    this.#input.log.warn("MCP Tool skipped", {
      reason,
      server: this.name,
      tool,
    });
  };
}
