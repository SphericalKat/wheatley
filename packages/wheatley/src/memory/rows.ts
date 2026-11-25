import type { SQLOutputValue } from "node:sqlite";

/** One row that `node:sqlite` returns. */
export type SqlRow = Record<string, SQLOutputValue>;

/** The SQLite storage class that a column must have. `?` allows `NULL`. */
type ColumnKind = "text" | "number" | "text?" | "number?";

interface ColumnTypes {
  readonly text: string;
  readonly number: number;
  readonly "text?": string | null;
  readonly "number?": number | null;
}

/** The expected storage class of each column of a query result. */
type ColumnKinds = Record<string, ColumnKind>;

/** The typed row of a query result with columns `Columns`. */
type RowOf<Columns extends ColumnKinds> = {
  readonly [Column in keyof Columns]: ColumnTypes[Columns[Column]];
};

const isText = (value: SQLOutputValue): value is string =>
  typeof value === "string";

const isNumber = (value: SQLOutputValue): value is number =>
  typeof value === "number";

const hasKind = (
  value: SQLOutputValue | undefined,
  kind: ColumnKind
): boolean => {
  if (value === undefined) {
    return false;
  }

  if (value === null) {
    return kind.endsWith("?");
  }

  return kind.startsWith("text") ? isText(value) : isNumber(value);
};

/**
 * Returns true if `row` has every column of `columns` with its storage class. Use it to narrow query results, for
 * example `rows.filter((row) => hasColumns(row, columns))`.
 */
export const hasColumns = <Columns extends ColumnKinds>(
  row: SqlRow,
  columns: Columns
): row is SqlRow & RowOf<Columns> =>
  Object.entries(columns).every(([column, kind]) => hasKind(row[column], kind));
