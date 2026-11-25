/** A JSON primitive value. */
export type JsonPrimitive = string | number | boolean | null;

/** A JSON object. Keys map to JSON values. */
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

/** Any value that `JSON.parse` can return. */
export type JsonValue = JsonPrimitive | readonly JsonValue[] | JsonObject;
