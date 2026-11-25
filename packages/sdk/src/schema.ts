import type { JsonObject, JsonValue } from "./json.js";

/**
 * A plain JSON Schema document (draft 2020-12), for example `{ "type": "object", "properties": {} }`.
 *
 * Wheatley validates input against it and forwards it to the model provider unchanged.
 */
export type JsonSchema = JsonObject;

/** The JSON Schema dialects that Wheatley requests from a Standard JSON Schema converter. */
export type StandardJsonSchemaTarget =
  | "draft-2020-12"
  | "draft-07"
  | "openapi-3.0";

/** Options that Wheatley passes to a Standard JSON Schema converter. */
export interface StandardJsonSchemaOptions {
  readonly target: StandardJsonSchemaTarget;
  readonly libraryOptions?: JsonObject | undefined;
}

/**
 * A JSON Schema document that a Standard JSON Schema converter returns.
 *
 * The Standard JSON Schema V1 specification (https://standardschema.dev) fixes this type. Wheatley keeps it so that
 * schemas from Zod, Valibot, ArkType, and other libraries stay assignable, and decodes the document at its boundary.
 */
// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- The Standard JSON Schema V1 specification fixes this type.
export type StandardJsonSchemaDocument = Record<string, unknown>;

/** The converter of the Standard JSON Schema V1 specification. */
export interface StandardJsonSchemaConverter {
  readonly input: (
    options: StandardJsonSchemaOptions
  ) => StandardJsonSchemaDocument;
  readonly output: (
    options: StandardJsonSchemaOptions
  ) => StandardJsonSchemaDocument;
}

/** One issue that a Standard Schema validator reports. */
export interface StandardSchemaIssue {
  readonly message: string;
  readonly path?:
    | readonly (PropertyKey | { readonly key: PropertyKey })[]
    | undefined;
}

/** The result of a Standard Schema `validate` call. */
export type StandardSchemaResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: readonly StandardSchemaIssue[] };

/** The `~standard` property of a Standard JSON Schema V1 value, with the optional Standard Schema V1 validator. */
export interface StandardJsonSchemaProps<Input, Output> {
  readonly version: 1;
  readonly vendor: string;
  readonly jsonSchema: StandardJsonSchemaConverter;
  readonly types?:
    | { readonly input: Input; readonly output: Output }
    | undefined;
  /**
   * Present when the library also implements Standard Schema V1. Wheatley then validates input with it instead of the
   * converted JSON Schema, so library refinements and transforms apply.
   */
  readonly validate?: (
    value: JsonValue
  ) => StandardSchemaResult<Output> | Promise<StandardSchemaResult<Output>>;
}

/** A schema object that implements Standard JSON Schema V1, for example a Zod 4 schema. */
export interface StandardJsonSchemaV1<Input = JsonValue, Output = Input> {
  readonly "~standard": StandardJsonSchemaProps<Input, Output>;
}

/**
 * A schema that Wheatley accepts for Tool input and Plugin or Frontend configuration: plain JSON Schema or a Standard
 * JSON Schema V1 object (ADR 0006).
 */
export type SchemaInput<Output = JsonValue> =
  | JsonSchema
  | StandardJsonSchemaV1<JsonValue, Output>;

/** The value type that a schema produces after validation. Plain JSON Schema produces `JsonValue`. */
export type SchemaOutput<Schema> =
  Schema extends StandardJsonSchemaV1<JsonValue, infer Output>
    ? Output
    : JsonValue;

/** Returns true if `schema` implements Standard JSON Schema V1 rather than plain JSON Schema. */
export const isStandardJsonSchema = <Output>(
  schema: SchemaInput<Output>
): schema is StandardJsonSchemaV1<JsonValue, Output> => "~standard" in schema;
