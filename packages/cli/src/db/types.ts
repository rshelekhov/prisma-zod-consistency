/**
 * Types describing what each Group B rule needs from the live database.
 *
 * The DB-fetching code lives in `postgres.ts` and is fully separated from
 * the rule logic (rules in `r07/r08/r09` operate on these data structures).
 * This split keeps the rules unit-testable without spinning up Postgres.
 */

/** Common options accepted by every adapter in the Group B dispatch table. */
export interface DbConnectOptions {
  /** Connection string — typically `process.env.DATABASE_URL`. Provider-specific format. */
  url: string;
  /**
   * Schema/database to introspect. Defaults to a provider-appropriate value:
   *   - postgres → `public`
   *   - mysql    → database name parsed from URL
   *   - sqlite   → ignored (single-database file)
   */
  schema?: string;
  /** Tables to skip entirely (e.g. internal Prisma migration tables). */
  excludeTables?: string[];
}

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

/**
 * A column row, normalized across providers.
 *
 * Sources by provider:
 *   - postgres → `information_schema.columns`
 *   - mysql    → `INFORMATION_SCHEMA.COLUMNS`
 *   - sqlite   → `PRAGMA table_info(...)`
 *
 * Provider-specific notes:
 *   - `udtName` mirrors Postgres `udt_name` (e.g. "varchar", "int4"). For MySQL
 *     we copy `DATA_TYPE` (e.g. "varchar", "int"); for SQLite we copy the
 *     declared type lowercased (e.g. "integer", "text"). R09b consumes this
 *     for type-drift comparison; precision is provider-dependent.
 *   - `characterMaximumLength` is `null` on SQLite (no enforced length) and
 *     for non-string types on every provider.
 *   - `columnDefault` is the raw default expression as the provider reports
 *     it (e.g. `'draft'::text` on Postgres, `'draft'` on MySQL,
 *     `'draft'` or `NULL` on SQLite). R09d normalizes both sides before
 *     comparison; consumers shouldn't string-compare directly.
 */
export interface DbColumn {
  schemaName: string;
  tableName: string;
  columnName: string;
  /** Broad data type as reported by the provider's metadata (e.g. "character varying", "varchar", "integer"). */
  dataType: string;
  /** Specific type identifier — see provider notes above. */
  udtName: string;
  isNullable: boolean;
  characterMaximumLength: number | null;
  /** Raw DEFAULT expression as the provider reports it. `null` when the column has no DEFAULT. */
  columnDefault: string | null;
}

/**
 * A foreign-key constraint as reported by the provider.
 *
 * Sources by provider:
 *   - postgres → `pg_constraint` (contype = 'f') + `pg_attribute`
 *   - mysql    → `INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS` + `KEY_COLUMN_USAGE`
 *   - sqlite   → `PRAGMA foreign_key_list(<table>)` per table
 *
 * Multi-column FKs are emitted as a single entry whose `columns[i]` references
 * `referencedColumns[i]` (parallel arrays in declaration order).
 *
 * `onDelete` / `onUpdate` are normalized to the lowercase action vocabulary
 * SQL standard uses; missing actions default to `"no action"`.
 */
export interface DbForeignKey {
  schemaName: string;
  tableName: string;
  /** FK constraint name as the DB knows it. */
  constraintName: string;
  /** Source columns. */
  columns: string[];
  /** Referenced table. */
  referencedTable: string;
  /** Referenced columns (parallel to `columns`). */
  referencedColumns: string[];
  /** Action on DELETE. Normalized vocabulary across providers. */
  onDelete: ForeignKeyAction;
  /** Action on UPDATE. Same normalization. */
  onUpdate: ForeignKeyAction;
}

/** SQL-standard referential-action vocabulary, lowercased and normalized across providers. */
export type ForeignKeyAction = "cascade" | "restrict" | "no action" | "set null" | "set default";

/**
 * Provider-level capabilities exposed by the snapshot. Consumed by rules that
 * can't run uniformly across every supported DB — e.g. R08 needs index-usage
 * statistics, which Postgres and MySQL track but SQLite does not.
 */
export interface DbCapabilities {
  /**
   * Whether the underlying provider gives us per-index read counts.
   * - `true`  → Postgres (`pg_stat_user_indexes`), MySQL with `performance_schema`.
   * - `false` → SQLite (no usage stats), MySQL with `performance_schema=OFF`.
   * R08 silently skips when this is `false`.
   */
  indexUsageTracking: boolean;
  /**
   * Whether the underlying provider reports column types precisely enough for
   * R09b (type drift) to make meaningful comparisons.
   * - `true`  → Postgres (`udt_name` + `character_maximum_length`), MySQL
   *            (`DATA_TYPE` + `character_maximum_length`).
   * - `false` → SQLite — its column types are affinities, declared lengths
   *            are not enforced, and `VARCHAR(100)` vs `varchar(255)` is
   *            indistinguishable. R09b silently skips when this is `false`.
   */
  typeDriftAccurate: boolean;
}

/** Bundle handed to Group B rules. */
export interface DbSnapshot {
  indexes: DbIndex[];
  indexUsage: DbIndexUsage[];
  columns: DbColumn[];
  /** Foreign-key constraints — consumed by R09c (FK constraints drift). */
  foreignKeys: DbForeignKey[];
  capabilities: DbCapabilities;
}
