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
 * Provider-specific notes (R09b will tighten these):
 *   - `udtName` mirrors Postgres `udt_name` (e.g. "varchar", "int4"). For MySQL
 *     we copy `DATA_TYPE` (e.g. "varchar", "int"); for SQLite we copy the
 *     declared type lowercased (e.g. "integer", "text").
 *   - `characterMaximumLength` is `null` on SQLite (no enforced length) and
 *     for non-string types on every provider.
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
}

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
}

/** Bundle handed to Group B rules. */
export interface DbSnapshot {
  indexes: DbIndex[];
  indexUsage: DbIndexUsage[];
  columns: DbColumn[];
  capabilities: DbCapabilities;
}
