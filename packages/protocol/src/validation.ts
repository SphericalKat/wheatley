import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";

import type { JsonValue } from "./json.js";

/** One validation problem. `path` is a JSON Pointer into the value, for example `/agents/home/model`. */
export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

/** The result of `decode`. */
export type Decoded<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] };

/** Lists the problems of `value` against `schema`. Returns an empty list for a valid value. */
export const validationIssues = (
  schema: TSchema,
  value: JsonValue
): ValidationIssue[] =>
  Value.Errors(schema, value).map((error) => ({
    message: error.message,
    path: error.instancePath === "" ? "/" : error.instancePath,
  }));

/** Checks `value` against a protocol schema and returns it typed, or the validation issues. */
export const decode = <Schema extends TSchema>(
  schema: Schema,
  value: JsonValue
): Decoded<Static<Schema>> =>
  Value.Check(schema, value)
    ? { ok: true, value }
    : { issues: validationIssues(schema, value), ok: false };
