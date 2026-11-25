import type { PermissionAction } from "@wheatley/protocol";
import type { Frontend, PluginContributions } from "@wheatley/sdk";

import type { ToolDescriptor } from "../contracts/extension-catalog.js";
import { canonicalToolName } from "../contracts/tool-names.js";
import {
  errorMessage,
  hasDispose,
  isContributionsObject,
  isPluginFrontend,
  isPluginTool,
} from "./guards.js";
import type { PluginTool } from "./guards.js";
import { compileSchema } from "./schema.js";
import type { CompiledSchema } from "./schema.js";

/** Plugin Tools have no built-in default, so a call without a matching Permission Policy rule asks. */
const PLUGIN_DEFAULT_ACTION: PermissionAction = "ask";

/** One Plugin Tool, ready to run. */
export interface LoadedTool {
  readonly descriptor: ToolDescriptor;
  readonly schema: CompiledSchema;
  readonly tool: PluginTool;
}

/** What `setup` of one Plugin returned, after validation. */
export interface Contributions {
  readonly tools: readonly LoadedTool[];
  readonly frontends: readonly Frontend[];
  /** Calls the Plugin's `dispose`, or resolves at once if it has none. */
  readonly dispose: () => Promise<void>;
}

const loadTool = (plugin: string, tool: PluginTool): LoadedTool => {
  let schema: CompiledSchema;

  try {
    schema = compileSchema(tool.inputSchema);
  } catch (error) {
    throw new TypeError(
      `Tool ${tool.name} has an invalid inputSchema: ${errorMessage(error)}`,
      { cause: error }
    );
  }

  return {
    descriptor: {
      defaultAction: PLUGIN_DEFAULT_ACTION,
      description: tool.description,
      inputSchema: schema.jsonSchema,
      name: canonicalToolName({ kind: "plugin", plugin }, tool.name),
      source: "plugin",
    },
    schema,
    tool,
  };
};

const loadFrontend = (frontend: Frontend): Frontend => {
  try {
    compileSchema(frontend.configSchema);
  } catch (error) {
    throw new TypeError(
      `Frontend ${frontend.type} has an invalid configSchema: ${errorMessage(error)}`,
      { cause: error }
    );
  }

  return frontend;
};

const firstDuplicate = (values: readonly string[]): string | undefined =>
  values.find((value, index) => values.indexOf(value) !== index);

/**
 * Returns a function that calls the `dispose` function of what `setup` returned, so that a caller can release a
 * Plugin whose contributions fail validation or arrive too late. `setup` is Plugin code, so `returned` is unchecked.
 * The function does nothing if there is no `dispose` function.
 */
export const disposerOf = (
  returned: PluginContributions
): (() => Promise<void>) => {
  if (!hasDispose(returned)) {
    return async () => {
      await Promise.resolve();
    };
  }

  return async () => {
    await returned.dispose();
  };
};

/**
 * Validates what `setup` of the Plugin `plugin` returned against `PluginContributions` of `@wheatley/sdk` and names
 * its Tools `<plugin>:<tool>`.
 *
 * Errors: throws a `TypeError` or `RangeError` with a message for Agent health if the value is not a contributions
 * object, a Tool or Frontend breaks its contract, a Tool name breaks `^[a-z][a-z0-9_]*$`, two Tools share a name, two
 * Frontends share a `type`, or `dispose` is not a function.
 */
export const loadContributions = (
  plugin: string,
  returned: PluginContributions
): Contributions => {
  if (!isContributionsObject(returned)) {
    throw new TypeError(
      "setup did not return a contributions object with optional tools and frontends arrays"
    );
  }

  if (returned.dispose !== undefined && !hasDispose(returned)) {
    throw new TypeError("setup returned dispose that is not a function");
  }

  const toolValues: readonly unknown[] = returned.tools ?? [];
  const frontendValues: readonly unknown[] = returned.frontends ?? [];

  const tools = toolValues.map((tool, index) => {
    if (!isPluginTool(tool)) {
      throw new TypeError(
        `Tool ${index} breaks the Tool contract: it needs name and description strings, an inputSchema of plain JSON Schema or Standard JSON Schema, and an execute function`
      );
    }

    return loadTool(plugin, tool);
  });

  const frontends = frontendValues.map((frontend, index) => {
    if (!isPluginFrontend(frontend)) {
      throw new TypeError(
        `Frontend ${index} breaks the Frontend contract: it needs a type string, a configSchema of plain JSON Schema or Standard JSON Schema, and a createBinding function`
      );
    }

    return loadFrontend(frontend);
  });

  const duplicateTool = firstDuplicate(
    tools.map((tool) => tool.descriptor.name)
  );

  if (duplicateTool !== undefined) {
    throw new TypeError(`setup returned two Tools named ${duplicateTool}`);
  }

  const duplicateFrontend = firstDuplicate(
    frontends.map((frontend) => frontend.type)
  );

  if (duplicateFrontend !== undefined) {
    throw new TypeError(
      `setup returned two Frontends of type ${duplicateFrontend}`
    );
  }

  return { dispose: disposerOf(returned), frontends, tools };
};
