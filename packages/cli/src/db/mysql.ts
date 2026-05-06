/**
 * MySQL adapter for Group B (live-DB) rules.
 *
 * Uses `mysql2/promise` — the maintained successor to `mysql`. MariaDB shares
 * the same wire protocol and `provider = "mysql"` in Prisma, so this adapter
 * works against MariaDB transparently. Old MariaDB instances (pre-10.6) may
 * not expose `sys.schema_unused_indexes`; we don't depend on that view —
 * `performance_schema.table_io_waits_summary_by_index_usage` covers the same
 * data and ships in MySQL 5.7+ / MariaDB 10.0+.
 *
 * Like the other adapters, this module is loaded dynamically by `db/index.ts`,
 * so the `mysql2` driver can stay an optional peer dep.
 *
 * ## Capability differences vs Postgres
 *
 * - **Index usage:** MySQL counts per-index reads in
 *   `performance_schema.table_io_waits_summary_by_index_usage.count_read`,
 *   conceptually close to Postgres `pg_stat_user_indexes.idx_scan`. This
 *   requires `performance_schema=ON`, which is the default in MySQL 5.7+.
 *   When it's off, `count_read` comes back NULL — we coerce to 0 and emit a
 *   single warning via `capabilities.indexUsageTracking = false`, so R08
 *   silently skips rather than producing false positives across every index.
 * - **R08 semantics on MySQL:** The Postgres rule combines `idx_scan = 0`
 *   with `seq_scan > 0` to gate against dormant tables. MySQL has no
 *   per-table seq-scan counter, so we set `tableSeqScan` to a sentinel
 *   non-zero value (`1`) when the index has any sibling activity at all,
 *   effectively dropping the seq_scan condition for MySQL. The
 *   `R08.minRowCount` filter (default 1000) still suppresses the bulk of
 *   false positives. This is documented in R08 spec under "Provider support".
 * - **Partial indexes:** MySQL has functional/expression indexes from 8.0+,
 *   but no Postgres-style partial-index `WHERE` clauses. We always set
 *   `isPartial = false`.
 * - **Schema selection:** MySQL terminology calls this a "database". We pull
 *   it from the `DATABASE_URL` path component or accept it via
 *   `opts.schema` for symmetry with Postgres.
 */

import type { Pool as Mysql2Pool, RowDataPacket } from "mysql2/promise";
import type {
  DbColumn,
  DbConnectOptions,
  DbForeignKey,
  DbIndex,
  DbIndexUsage,
  DbSnapshot,
  ForeignKeyAction,
} from "./types.js";

const DEFAULT_EXCLUDE_TABLES = ["_prisma_migrations"];

interface IndexRow {
  schema_name: string;
  table_name: string;
  index_name: string;
  column_name: string | null; // null for prefix-only / functional entries on some flavors
  seq: number;
  non_unique: 0 | 1;
  index_type: string;
}

interface UsageRow {
  schema_name: string;
  table_name: string;
  index_name: string;
  // performance_schema can return NULL when the row is missing or
  // performance_schema is disabled; we coerce to 0 in mapping.
  count_read: number | null;
  approx_rows: number | null;
}

interface ColumnRow {
  schema_name: string;
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: "YES" | "NO";
  character_maximum_length: number | null;
  column_default: string | null;
}

/**
 * One row per FK column from `INFORMATION_SCHEMA.KEY_COLUMN_USAGE`, joined
 * against `REFERENTIAL_CONSTRAINTS` for the action codes. Multi-column FKs
 * land as multiple rows with the same `constraint_name` and ascending
 * `ordinal_position`.
 */
interface FkRow {
  schema_name: string;
  table_name: string;
  constraint_name: string;
  column_name: string;
  ordinal_position: number;
  referenced_table: string;
  referenced_column: string;
  delete_rule: string;
  update_rule: string;
}

export async function snapshotMysql(opts: DbConnectOptions): Promise<DbSnapshot> {
  const mysql = await loadDriver();
  const pool = mysql.createPool({ uri: opts.url, connectionLimit: 1 });
  const schema = opts.schema ?? deriveSchemaFromUrl(opts.url);
  if (!schema) {
    await pool.end();
    throw new Error(
      "Could not derive MySQL database name from DATABASE_URL. Provide it via the URL " +
        "(`mysql://user:pass@host:3306/<dbname>`) or pass `schema` explicitly.",
    );
  }
  const excludeTables = new Set([...DEFAULT_EXCLUDE_TABLES, ...(opts.excludeTables ?? [])]);

  try {
    const [indexes, indexUsage, columns, foreignKeys, usageTrackingOn] = await Promise.all([
      fetchIndexes(pool, schema, excludeTables),
      fetchIndexUsage(pool, schema, excludeTables),
      fetchColumns(pool, schema, excludeTables),
      fetchForeignKeys(pool, schema, excludeTables),
      probePerformanceSchema(pool),
    ]);
    return {
      indexes,
      indexUsage,
      columns,
      foreignKeys,
      capabilities: { indexUsageTracking: usageTrackingOn, typeDriftAccurate: true },
    };
  } finally {
    await pool.end();
  }
}

type Pool = Mysql2Pool;

async function fetchIndexes(pool: Pool, schema: string, exclude: Set<string>): Promise<DbIndex[]> {
  // INFORMATION_SCHEMA.STATISTICS yields one row per (index, column). We
  // group by (table, index) and reassemble columns ordered by SEQ_IN_INDEX.
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT
       TABLE_SCHEMA  AS schema_name,
       TABLE_NAME    AS table_name,
       INDEX_NAME    AS index_name,
       COLUMN_NAME   AS column_name,
       SEQ_IN_INDEX  AS seq,
       NON_UNIQUE    AS non_unique,
       INDEX_TYPE    AS index_type
     FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA = ?
     ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
    [schema],
  );

  return groupIndexRows(rows as unknown as IndexRow[], exclude);
}

/**
 * Pure mapping function — exposed for unit tests. Takes the row stream from
 * INFORMATION_SCHEMA.STATISTICS and emits one DbIndex per (table, index).
 */
export function groupIndexRows(rows: IndexRow[], exclude: Set<string>): DbIndex[] {
  const byKey = new Map<string, DbIndex>();
  for (const r of rows) {
    if (exclude.has(r.table_name)) continue;
    if (r.column_name === null) continue; // skip functional/expression slots
    const key = `${r.schema_name}.${r.table_name}.${r.index_name}`;
    let entry = byKey.get(key);
    if (!entry) {
      entry = {
        schemaName: r.schema_name,
        tableName: r.table_name,
        indexName: r.index_name,
        columns: [],
        // NON_UNIQUE = 0 means the index IS unique; 1 means it is not.
        isUnique: r.non_unique === 0,
        // MySQL convention — primary keys are always named "PRIMARY".
        isPrimary: r.index_name === "PRIMARY",
        // No partial-index concept in MySQL.
        isPartial: false,
      };
      byKey.set(key, entry);
    }
    // Rows arrive sorted by SEQ_IN_INDEX; safe to push in order.
    entry.columns.push(r.column_name);
  }
  return [...byKey.values()];
}

async function fetchIndexUsage(
  pool: Pool,
  schema: string,
  exclude: Set<string>,
): Promise<DbIndexUsage[]> {
  // We pull (schema, table, index) from STATISTICS as the source of truth and
  // LEFT JOIN performance_schema for the read counts. This way we get a row
  // per real index even if performance_schema lost the entry (which it
  // periodically does after server restart).
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT
       i.TABLE_SCHEMA                                AS schema_name,
       i.TABLE_NAME                                  AS table_name,
       i.INDEX_NAME                                  AS index_name,
       io.count_read                                 AS count_read,
       t.TABLE_ROWS                                  AS approx_rows
     FROM INFORMATION_SCHEMA.STATISTICS i
     LEFT JOIN performance_schema.table_io_waits_summary_by_index_usage io
       ON io.OBJECT_SCHEMA = i.TABLE_SCHEMA
       AND io.OBJECT_NAME  = i.TABLE_NAME
       AND io.INDEX_NAME   = i.INDEX_NAME
     LEFT JOIN INFORMATION_SCHEMA.TABLES t
       ON t.TABLE_SCHEMA = i.TABLE_SCHEMA
       AND t.TABLE_NAME  = i.TABLE_NAME
     WHERE i.TABLE_SCHEMA = ?
       AND i.SEQ_IN_INDEX = 1`,
    [schema],
  );

  return mapUsageRows(rows as unknown as UsageRow[], exclude);
}

/**
 * Pure mapping — exposed for tests. Coerces NULLs to 0 and drops excluded
 * tables. The `tableSeqScan` field is set to `1` whenever the index has any
 * read activity at all, so the R08 condition `tableSeqScan === 0` (which
 * Postgres uses to skip dormant tables) effectively becomes "table is
 * dormant only if literally nothing has touched any index on it" — a softer
 * gate but enough to suppress the most obvious noise. R08's `minRowCount`
 * filter handles the rest.
 */
export function mapUsageRows(rows: UsageRow[], exclude: Set<string>): DbIndexUsage[] {
  return rows
    .filter((r) => !exclude.has(r.table_name))
    .map((r) => {
      const idxScan = Number(r.count_read ?? 0);
      // Sentinel: any non-zero read on any index counts as table activity for
      // the purposes of R08's seq_scan gate. See module-level note.
      const tableSeqScan = idxScan > 0 ? 1 : 0;
      return {
        schemaName: r.schema_name,
        tableName: r.table_name,
        indexName: r.index_name,
        idxScan,
        tableSeqScan,
        approxRowCount: Number(r.approx_rows ?? 0),
      };
    });
}

async function fetchColumns(pool: Pool, schema: string, exclude: Set<string>): Promise<DbColumn[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT
       TABLE_SCHEMA              AS schema_name,
       TABLE_NAME                AS table_name,
       COLUMN_NAME               AS column_name,
       DATA_TYPE                 AS data_type,
       IS_NULLABLE               AS is_nullable,
       CHARACTER_MAXIMUM_LENGTH  AS character_maximum_length,
       COLUMN_DEFAULT            AS column_default
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = ?
     ORDER BY TABLE_NAME, ORDINAL_POSITION`,
    [schema],
  );

  return mapColumnRows(rows as unknown as ColumnRow[], exclude);
}

/** Pure mapping — exposed for tests. */
export function mapColumnRows(rows: ColumnRow[], exclude: Set<string>): DbColumn[] {
  return rows
    .filter((r) => !exclude.has(r.table_name))
    .map((r) => ({
      schemaName: r.schema_name,
      tableName: r.table_name,
      columnName: r.column_name,
      dataType: r.data_type,
      udtName: r.data_type,
      isNullable: r.is_nullable === "YES",
      characterMaximumLength: r.character_maximum_length,
      columnDefault: r.column_default,
    }));
}

async function fetchForeignKeys(
  pool: Pool,
  schema: string,
  exclude: Set<string>,
): Promise<DbForeignKey[]> {
  // KEY_COLUMN_USAGE has the source/target columns and ordinal positions;
  // REFERENTIAL_CONSTRAINTS carries DELETE_RULE / UPDATE_RULE. We join on the
  // constraint name (within the same schema). Multi-column FKs come back as
  // multiple rows with the same constraint_name and ascending ordinal_position.
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT
       kcu.TABLE_SCHEMA              AS schema_name,
       kcu.TABLE_NAME                AS table_name,
       kcu.CONSTRAINT_NAME           AS constraint_name,
       kcu.COLUMN_NAME               AS column_name,
       kcu.ORDINAL_POSITION          AS ordinal_position,
       kcu.REFERENCED_TABLE_NAME     AS referenced_table,
       kcu.REFERENCED_COLUMN_NAME    AS referenced_column,
       rc.DELETE_RULE                AS delete_rule,
       rc.UPDATE_RULE                AS update_rule
     FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
     JOIN INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS rc
       ON rc.CONSTRAINT_SCHEMA = kcu.TABLE_SCHEMA
      AND rc.CONSTRAINT_NAME   = kcu.CONSTRAINT_NAME
     WHERE kcu.TABLE_SCHEMA = ?
       AND kcu.REFERENCED_TABLE_NAME IS NOT NULL
     ORDER BY kcu.TABLE_NAME, kcu.CONSTRAINT_NAME, kcu.ORDINAL_POSITION`,
    [schema],
  );

  return groupMysqlForeignKeyRows(rows as unknown as FkRow[], exclude);
}

/**
 * Pure mapping — exposed for tests. Groups multi-column FK rows by
 * `(schema, table, constraint_name)` and emits one DbForeignKey per group with
 * `columns` / `referencedColumns` parallel arrays in `ordinal_position` order.
 *
 * MySQL `REFERENTIAL_CONSTRAINTS.DELETE_RULE` / `UPDATE_RULE` come as the
 * SQL-standard text ("CASCADE", "RESTRICT", "NO ACTION", "SET NULL",
 * "SET DEFAULT") — lowercased they match `ForeignKeyAction` directly.
 */
export function groupMysqlForeignKeyRows(rows: FkRow[], exclude: Set<string>): DbForeignKey[] {
  const byKey = new Map<string, DbForeignKey>();
  for (const r of rows) {
    if (exclude.has(r.table_name)) continue;
    const key = `${r.schema_name}.${r.table_name}.${r.constraint_name}`;
    let entry = byKey.get(key);
    if (!entry) {
      entry = {
        schemaName: r.schema_name,
        tableName: r.table_name,
        constraintName: r.constraint_name,
        columns: [],
        referencedTable: r.referenced_table,
        referencedColumns: [],
        onDelete: mysqlActionFromText(r.delete_rule),
        onUpdate: mysqlActionFromText(r.update_rule),
      };
      byKey.set(key, entry);
    }
    // Rows arrive sorted by ORDINAL_POSITION; safe to push in order.
    entry.columns.push(r.column_name);
    entry.referencedColumns.push(r.referenced_column);
  }
  return [...byKey.values()];
}

function mysqlActionFromText(text: string): ForeignKeyAction {
  switch (text.toUpperCase().trim()) {
    case "CASCADE":
      return "cascade";
    case "RESTRICT":
      return "restrict";
    case "SET NULL":
      return "set null";
    case "SET DEFAULT":
      return "set default";
    default:
      // "NO ACTION" or any unknown — bucket into the SQL standard default.
      return "no action";
  }
}

/**
 * Probe whether `performance_schema` is enabled and reports any rows for
 * `table_io_waits_summary_by_index_usage`. If it isn't, every count_read
 * comes back NULL and R08 would flag every index as unused — return false so
 * R08 silently skips and a one-shot warning is emitted by the runner.
 */
async function probePerformanceSchema(pool: Pool): Promise<boolean> {
  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) > 0 AS \`on\`
       FROM performance_schema.table_io_waits_summary_by_index_usage
       LIMIT 1`,
    );
    const r = (rows as unknown as { on: number | string }[])[0];
    return r ? Number(r.on) === 1 : false;
  } catch {
    // performance_schema entirely disabled — querying it throws.
    return false;
  }
}

/** Best-effort: pull dbname from a `mysql://user:pass@host:3306/<dbname>` URL. */
function deriveSchemaFromUrl(url: string): string | undefined {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/^\//, "");
    return path === "" ? undefined : path.split("?")[0];
  } catch {
    return undefined;
  }
}

/**
 * Dynamically import `mysql2/promise` and return its module. Gives an
 * actionable error message when the package isn't installed.
 */
async function loadDriver(): Promise<typeof import("mysql2/promise")> {
  try {
    return await import("mysql2/promise");
  } catch (err) {
    throw new Error(
      `Group B rules need the 'mysql2' package to introspect a MySQL/MariaDB database, but it is not installed. Install it as a dev dependency: \`pnpm add -D mysql2\` (or \`npm i -D mysql2\`). Original error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
