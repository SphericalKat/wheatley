import { isJsonValue } from "@wheatley/protocol";
import { API_VERSION } from "@wheatley/sdk";
import type {
  Frontend,
  JsonObject,
  JsonValue,
  Plugin,
  PluginContributions,
  SchemaInput,
  StandardJsonSchemaProps,
  StandardJsonSchemaV1,
  ToolResult,
} from "@wheatley/sdk";

const STANDARD_KEY = "~standard";
const STANDARD_VERSION = 1;

/** The message of a thrown value, for Agent health and logs. */
export const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** Returns true if `value` is a JSON object: a plain object whose values are all JSON values. */
export const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  isJsonValue(value);

const isStandardProps = (
  value: unknown
): value is StandardJsonSchemaProps<JsonValue, unknown> =>
  typeof value === "object" &&
  value !== null &&
  "version" in value &&
  value.version === STANDARD_VERSION &&
  "jsonSchema" in value &&
  typeof value.jsonSchema === "object" &&
  value.jsonSchema !== null &&
  "input" in value.jsonSchema &&
  typeof value.jsonSchema.input === "function" &&
  (!("validate" in value) ||
    value.validate === undefined ||
    typeof value.validate === "function");

/** Returns true if `value` implements Standard JSON Schema V1: a `~standard` property with a `jsonSchema.input` converter. */
export const isStandardSchemaValue = (
  value: unknown
): value is StandardJsonSchemaV1<JsonValue, unknown> =>
  typeof value === "object" &&
  value !== null &&
  STANDARD_KEY in value &&
  isStandardProps(value[STANDARD_KEY]);

/**
 * Returns true if `value` is a schema that a Plugin can provide: a Standard JSON Schema V1 object, or a plain JSON
 * Schema object with only JSON values. An object with a `~standard` property counts only as Standard JSON Schema.
 */
export const isSchemaInput = (value: unknown): value is SchemaInput<unknown> =>
  typeof value === "object" && value !== null && STANDARD_KEY in value
    ? isStandardSchemaValue(value)
    : isJsonObject(value);

/** Returns true if `value` is an ES module namespace or object with a `default` property. */
export const hasDefaultExport = (
  value: unknown
): value is { readonly default: unknown } =>
  typeof value === "object" && value !== null && "default" in value;

/** Returns true if `value` is an object with an `apiVersion` property of any value. */
export const hasApiVersion = (
  value: unknown
): value is { readonly apiVersion: unknown } =>
  typeof value === "object" && value !== null && "apiVersion" in value;

/**
 * Returns true if `value` has the runtime form of a `Plugin` of `@wheatley/sdk`: `apiVersion` 1, `name` and `version`
 * strings, a `setup` function, and an optional schema as `configSchema`. It does not check the name pattern.
 */
export const isPlugin = (value: unknown): value is Plugin<unknown> =>
  typeof value === "object" &&
  value !== null &&
  "apiVersion" in value &&
  value.apiVersion === API_VERSION &&
  "name" in value &&
  typeof value.name === "string" &&
  "version" in value &&
  typeof value.version === "string" &&
  "setup" in value &&
  typeof value.setup === "function" &&
  (!("configSchema" in value) ||
    value.configSchema === undefined ||
    isSchemaInput(value.configSchema));

/** The Tool type of `PluginContributions`, which accepts any input type. */
export type PluginTool = NonNullable<PluginContributions["tools"]>[number];

/** Returns true if `value` has the runtime form of a `Tool` of `@wheatley/sdk`. It does not check the name pattern. */
export const isPluginTool = (value: unknown): value is PluginTool =>
  typeof value === "object" &&
  value !== null &&
  "name" in value &&
  typeof value.name === "string" &&
  "description" in value &&
  typeof value.description === "string" &&
  "inputSchema" in value &&
  isSchemaInput(value.inputSchema) &&
  "execute" in value &&
  typeof value.execute === "function";

/** Returns true if `value` has the runtime form of a `Frontend` of `@wheatley/sdk`. */
export const isPluginFrontend = (value: unknown): value is Frontend =>
  typeof value === "object" &&
  value !== null &&
  "type" in value &&
  typeof value.type === "string" &&
  "configSchema" in value &&
  isSchemaInput(value.configSchema) &&
  "createBinding" in value &&
  typeof value.createBinding === "function";

/** Returns true if `value` is an object with a `dispose` function, valid contributions or not. */
export const hasDispose = (
  value: unknown
): value is { readonly dispose: () => Promise<void> | void } =>
  typeof value === "object" &&
  value !== null &&
  "dispose" in value &&
  typeof value.dispose === "function";

/** Returns true if `value` is an object whose `tools` and `frontends`, if present, are arrays. */
export const isContributionsObject = (
  value: unknown
): value is {
  readonly tools?: readonly unknown[];
  readonly frontends?: readonly unknown[];
  readonly dispose?: unknown;
} =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  (!("tools" in value) ||
    value.tools === undefined ||
    Array.isArray(value.tools)) &&
  (!("frontends" in value) ||
    value.frontends === undefined ||
    Array.isArray(value.frontends));

const isToolContent = (
  block: unknown
): block is ToolResult["content"][number] =>
  typeof block === "object" &&
  block !== null &&
  "type" in block &&
  ((block.type === "text" &&
    "text" in block &&
    typeof block.text === "string") ||
    (block.type === "image" &&
      "mimeType" in block &&
      typeof block.mimeType === "string" &&
      "data" in block &&
      typeof block.data === "string"));

/** Returns true if a value that a Plugin Tool returned is a `ToolResult`. */
export const isToolResult = (value: unknown): value is ToolResult =>
  typeof value === "object" &&
  value !== null &&
  "content" in value &&
  Array.isArray(value.content) &&
  value.content.every(isToolContent) &&
  (!("isError" in value) ||
    value.isError === undefined ||
    typeof value.isError === "boolean");
