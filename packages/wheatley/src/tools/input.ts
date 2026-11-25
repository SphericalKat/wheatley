import type { JsonObject, JsonValue } from "@wheatley-ai/sdk";

/** The result of reading a Tool input object. */
export type InputCheck<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string };

const isObject = (value: JsonValue): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isString = (value: JsonValue | undefined): value is string =>
  typeof value === "string";

const isNonNegativeInteger = (value: JsonValue | undefined): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

/** Field rules of one Tool input object. */
export type FieldRule = "string" | "optional-string" | "optional-integer";

const fieldMatches = (
  rule: FieldRule,
  value: JsonValue | undefined
): boolean => {
  if (rule === "string") {
    return isString(value);
  }

  if (value === undefined) {
    return true;
  }

  return rule === "optional-string"
    ? isString(value)
    : isNonNegativeInteger(value);
};

/**
 * Checks that `input` is an object with exactly the fields of `rules`. Returns the object, or a message that names the
 * first field that breaks its rule.
 */
export const checkInput = (
  input: JsonValue,
  rules: Readonly<Record<string, FieldRule>>
): InputCheck<JsonObject> => {
  if (!isObject(input)) {
    return { message: "The input must be a JSON object", ok: false };
  }

  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(rules, key)) {
      return { message: `Unknown input field: ${key}`, ok: false };
    }
  }

  for (const [key, rule] of Object.entries(rules)) {
    if (!fieldMatches(rule, input[key])) {
      const expected =
        rule === "optional-integer" ? "a non-negative integer" : "a string";

      return { message: `The field ${key} must be ${expected}`, ok: false };
    }
  }

  return { ok: true, value: input };
};

/** Reads a string field that `checkInput` verified. */
export const stringField = (
  input: JsonObject,
  key: string
): string | undefined => {
  const value = input[key];

  return isString(value) ? value : undefined;
};

/** Reads an integer field that `checkInput` verified. */
export const integerField = (
  input: JsonObject,
  key: string
): number | undefined => {
  const value = input[key];

  return isNonNegativeInteger(value) ? value : undefined;
};
