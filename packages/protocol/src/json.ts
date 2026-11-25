/** A JSON primitive value. */
export type JsonPrimitive = string | number | boolean | null;

/** A JSON object. Keys map to JSON values. */
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

/** Any value that `JSON.parse` can return. */
export type JsonValue = JsonPrimitive | readonly JsonValue[] | JsonObject;

/**
 * Returns true if `value` contains only JSON values: no `undefined`, functions, symbols, bigints, non-finite numbers,
 * or class instances other than plain objects and arrays. Use it at boundaries such as a YAML parser.
 */
export const isJsonValue = (value: unknown): value is JsonValue => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }

  if (typeof value === "number") {
    return Number.isFinite(value);
  }

  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }

  if (
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return false;
  }

  return Object.values(value).every(isJsonValue);
};
