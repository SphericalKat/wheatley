import type { JsonSchema } from "@wheatley-ai/sdk";
import type { TSchema } from "typebox";

const isJsonObject = (value: unknown): value is JsonSchema =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Converts a TypeBox schema, which is plain JSON Schema, to the SDK `JsonSchema` type. */
export const toJsonSchema = (schema: TSchema): JsonSchema => {
  const value: unknown = structuredClone(schema);

  if (!isJsonObject(value)) {
    throw new TypeError("A TypeBox schema must be a JSON object");
  }

  return value;
};
