/**
 * Types describing what each Group B rule needs from the live database.
 *
 * The DB-fetching code lives in `postgres.ts` and is fully separated from
 * the rule logic (rules in `r07/r08/r09` operate on these data structures).
 * This split keeps the rules unit-testable without spinning up Postgres.
 */

/** A single row from `pg_indexes` enriched with parsed column list and uniqueness. */
export interface DbIndex {
  schemaName: string;
  tableName: string;
  indexName: string;
  /** Ordered list of column names, including expression columns where applicable. */
  columns: string[];
  isUnique: boolean;
  isPrimary: boolean;
  /** Whether this is a partial index (`WHERE ...` clause). Excluded from redundancy analysis. */
  isPartial: boolean;
}

/** A row from `pg_stat_user_indexes` joined with `pg_stat_user_tables` for context. */
export interface DbIndexUsage {
  schemaName: string;
  tableName: string;
  indexName: string;
  idxScan: number;
  /** seq_scan on the parent table — high seq_scan with idx_scan=0 is the suspicious case. */
  tableSeqScan: number;
  /** Rows in the table; tiny tables often legitimately have unused indexes. */
  approxRowCount: number;
}

/** A column row from `information_schema.columns`. */
export interface DbColumn {
  schemaName: string;
  tableName: string;
  columnName: string;
  /** Postgres data type as reported by information_schema (e.g. "character varying"). */
  dataType: string;
  /** `udt_name` — the more specific type identifier (e.g. "varchar", "text", "int4"). */
  udtName: string;
  isNullable: boolean;
  characterMaximumLength: number | null;
}

/** Bundle handed to Group B rules. */
export interface DbSnapshot {
  indexes: DbIndex[];
  indexUsage: DbIndexUsage[];
  columns: DbColumn[];
}
