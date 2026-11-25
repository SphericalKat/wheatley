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

const hasColumns = <Columns extends ColumnKinds>(
  row: SqlRow,
  columns: Columns
): row is SqlRow & RowOf<Columns> =>
  Object.entries(columns).every(([column, kind]) => hasKind(row[column], kind));

/**
 * Returns `row` typed with `columns`. The rows come from the module's own STRICT tables, so a mismatch means that the
 * query and the schema differ. Throws an `Error` that names the columns for a mismatch.
 */
export const rowOf = <Columns extends ColumnKinds>(
  row: SqlRow,
  columns: Columns
): SqlRow & RowOf<Columns> => {
  if (!hasColumns(row, columns)) {
    throw new Error(
      `A Memory query row does not match the expected columns ${JSON.stringify(columns)}`
    );
  }

  return row;
};
