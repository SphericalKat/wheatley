import { compile } from "@earendil-works/pi-schema";
import type { ValidationError } from "@earendil-works/pi-schema";
import { isStandardJsonSchema } from "@wheatley-ai/sdk";
import type {
  JsonSchema,
  JsonValue,
  SchemaInput,
  StandardJsonSchemaV1,
  StandardSchemaIssue,
  StandardSchemaResult,
} from "@wheatley-ai/sdk";

import { errorMessage, isJsonObject } from "./guards.js";

/** The result of checking one value against a `CompiledSchema`. */
export type SchemaCheck =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly message: string };

/** A Plugin schema, ready to validate values. */
export interface CompiledSchema {
  /** Plain JSON Schema (draft 2020-12) for the model provider. */
  readonly jsonSchema: JsonSchema;
  /**
   * Validates `value`. Resolves the validated value, which a Standard Schema transform can change, or a message that
   * lists every issue. Rejects only if a Standard Schema validator throws.
   */
  readonly check: (value: JsonValue) => Promise<SchemaCheck>;
}

type PathSegment = NonNullable<StandardSchemaIssue["path"]>[number];

const JSON_SCHEMA_TARGET = "draft-2020-12";

const formatErrors = (errors: readonly ValidationError[]): string =>
  errors.map((error) => `${error.path || "/"}: ${error.message}`).join("; ");

/** Compiles plain JSON Schema with pi-schema. Throws if the schema is malformed or has an unresolved `$ref`. */
const jsonValidator = (
  jsonSchema: JsonSchema
): ((value: JsonValue) => SchemaCheck) => {
  const validator = compile(jsonSchema);

  return (value) => {
    const result = validator.validate(value);

    return result.ok
      ? { ok: true, value: result.value }
      : { message: formatErrors(result.errors), ok: false };
  };
};

const isKeyObject = (
  segment: PathSegment
): segment is { readonly key: PropertyKey } => typeof segment === "object";

const formatIssue = (issue: StandardSchemaIssue): string => {
  const segments = (issue.path ?? []).map((segment) =>
    String(isKeyObject(segment) ? segment.key : segment)
  );

  return `/${segments.join("/")}: ${issue.message}`;
};

const standardCheck = (result: StandardSchemaResult<unknown>): SchemaCheck =>
  result.issues === undefined
    ? { ok: true, value: result.value }
    : { message: result.issues.map(formatIssue).join("; "), ok: false };

const compileStandard = (
  schema: StandardJsonSchemaV1<JsonValue, unknown>
): CompiledSchema => {
  const props = schema["~standard"];
  const converted = props.jsonSchema.input({ target: JSON_SCHEMA_TARGET });

  if (!isJsonObject(converted)) {
    throw new TypeError(
      "The Standard JSON Schema converter did not return a JSON object"
    );
  }

  // Compiling also rejects a converted schema that the model provider could not read.
  const checkJson = jsonValidator(converted);

  return {
    check: async (value) =>
      props.validate === undefined
        ? checkJson(value)
        : standardCheck(await props.validate(value)),
    jsonSchema: converted,
  };
};

/**
 * Compiles a schema that a Plugin provided for Tool input or for configuration: plain JSON Schema or a Standard JSON
 * Schema V1 object (ADR 0006).
 *
 * Plain JSON Schema validates with `@earendil-works/pi-schema` and passes to the model provider unchanged. A Standard
 * JSON Schema converts to draft 2020-12 for the model provider. It validates with its own Standard Schema validator if
 * it has one, so library refinements and transforms apply, and with the converted JSON Schema otherwise.
 *
 * Errors: throws a `TypeError` with a message for Agent health if the converter fails or the JSON Schema is
 * malformed.
 */
export const compileSchema = (schema: SchemaInput<unknown>): CompiledSchema => {
  try {
    if (isStandardJsonSchema(schema)) {
      return compileStandard(schema);
    }

    const checkJson = jsonValidator(schema);

    return {
      check: async (value) => {
        await Promise.resolve();

        return checkJson(value);
      },
      jsonSchema: schema,
    };
  } catch (error) {
    throw new TypeError(`Invalid schema: ${errorMessage(error)}`, {
      cause: error,
    });
  }
};
