import type { SQLOutputValue } from "node:sqlite";

/** One row that `node:sqlite` returns. */
export type SqlRow = Readonly<Record<string, SQLOutputValue>>;

const columnError = (column: string, expected: string): Error =>
  new TypeError(`Column ${column} is not ${expected}`);

const isText = (value: SQLOutputValue | undefined): value is string =>
  typeof value === "string";

const isNumber = (value: SQLOutputValue | undefined): value is number =>
  typeof value === "number";

const isBigint = (value: SQLOutputValue | undefined): value is bigint =>
  typeof value === "bigint";

/** Reads a `TEXT NOT NULL` column. Throws a `TypeError` if the stored value has another type. */
export const textColumn = (row: SqlRow, column: string): string => {
  const value = row[column];

  if (!isText(value)) {
    throw columnError(column, "text");
  }

  return value;
};

/** Reads a `TEXT NOT NULL` column that holds one of `values`. Throws a `TypeError` for any other value. */
export const enumColumn = <const Value extends string>(
  row: SqlRow,
  column: string,
  values: readonly Value[]
): Value => {
  const stored = textColumn(row, column);
  const value = values.find((candidate) => candidate === stored);

  if (value === undefined) {
    throw new TypeError(`Column ${column} has an unknown value: ${stored}`);
  }

  return value;
};

/** Reads a nullable `TEXT` column. */
export const optionalTextColumn = (
  row: SqlRow,
  column: string
): string | null => {
  const value = row[column];

  if (value === null || value === undefined) {
    return null;
  }

  if (!isText(value)) {
    throw columnError(column, "text");
  }

  return value;
};

/** Reads an `INTEGER NOT NULL` column as a number. */
export const integerColumn = (row: SqlRow, column: string): number => {
  const value = row[column];

  if (isBigint(value)) {
    return Number(value);
  }

  if (!isNumber(value)) {
    throw columnError(column, "an integer");
  }

  return value;
};

/** Reads a nullable `INTEGER` column as a number. */
export const optionalIntegerColumn = (
  row: SqlRow,
  column: string
): number | null => {
  const value = row[column];

  if (value === null || value === undefined) {
    return null;
  }

  return integerColumn(row, column);
};

/** Reads a `BLOB NOT NULL` column. */
export const blobColumn = (row: SqlRow, column: string): Uint8Array => {
  const value = row[column];

  if (!(value instanceof Uint8Array)) {
    throw columnError(column, "a blob");
  }

  return value;
};
