/**
 * Postgres adapter for Group B (live-DB) rules.
 *
 * Only this module imports `postgres`. Everything downstream consumes the
 * pure data shapes in `types.ts`, so rule logic can be unit-tested with
 * fixture data instead of a live Postgres connection.
 */

import type postgres from "postgres";
// `postgres` is an optional peer; we pull it in dynamically inside snapshotPostgres.
// `import type` is a pure type reference — tsc strips it from emit, so it does NOT
// pull `postgres` at runtime even when the dependency is missing.
import { sanitizePrismaUrl } from "./sanitize-url.js";
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

/**
 * Postgres adapter. Imported dynamically by `db/index.ts` so that the `postgres`
 * driver can be an optional peer dependency — projects that never call --db,
 * or that use only --db with mysql/sqlite, don't need it installed.
 */
export async function snapshotPostgres(opts: DbConnectOptions): Promise<DbSnapshot> {
  // Dynamic import: keeps `postgres` an optional peer. If it's missing we
  // surface an actionable error here (mirrors the mysql/sqlite adapter wrappers)
  // rather than letting the bare `Cannot find package 'postgres'` reach the user.
  // The original `await import("postgres")` works at runtime but throws a bare
  // module-not-found error if the optional peer is missing. Wrap with the same
  // actionable hint the mysql/sqlite adapters give. We keep the
  // `default`-destructuring shape to match the previous TS inference (postgres
  // is published with `export = ...`, esModuleInterop synthesizes `.default`).
  const postgresModule = await import("postgres").catch((err) => {
    throw new Error(
      `Group B rules need the 'postgres' package to introspect a PostgreSQL database, but it is not installed. Install it as a dev dependency: \`pnpm add -D postgres\` (or \`npm i -D postgres\`). Original error: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
  const { default: postgres } = postgresModule;
  // Strip Prisma-only URL params (`?schema=`, `?connection_limit=`, …) before
  // handing the URL to postgres.js. See sanitize-url.ts for the full rationale.
  const { url: cleanUrl, searchPath } = sanitizePrismaUrl(opts.url, "postgresql");
  const sql = postgres(cleanUrl, {
    onnotice: () => {}, // suppress NOTICE noise
    max: 1,
  });
  // Effective schema in priority order:
  //   explicit opts.schema  >  ?schema= from DATABASE_URL  >  default "public"
  // Our subsequent queries are all fully-qualified via `WHERE n.nspname = ${schema}`,
  // so we do not need to issue a SET search_path round-trip — the value flows
  // directly into the parameterized predicates below.
  const schema = opts.schema ?? searchPath ?? "public";
  const excludeTables = new Set([...DEFAULT_EXCLUDE_TABLES, ...(opts.excludeTables ?? [])]);

  try {
    const [indexes, indexUsage, columns, foreignKeys] = await Promise.all([
      fetchIndexes(sql, schema, excludeTables),
      fetchIndexUsage(sql, schema, excludeTables),
      fetchColumns(sql, schema, excludeTables),
      fetchForeignKeys(sql, schema, excludeTables),
    ]);
    return {
      indexes,
      indexUsage,
      columns,
      foreignKeys,
      capabilities: { indexUsageTracking: true, typeDriftAccurate: true },
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

type Sql = ReturnType<typeof postgres>;

async function fetchIndexes(sql: Sql, schema: string, exclude: Set<string>): Promise<DbIndex[]> {
  // Pull the raw index metadata. We deliberately go through pg_index/pg_class
  // instead of pg_indexes because pg_indexes serializes the column list as a
  // string we'd then have to re-parse.
  const rows = await sql<
    Array<{
      schema_name: string;
      table_name: string;
      index_name: string;
      columns: string[];
      is_unique: boolean;
      is_primary: boolean;
      is_partial: boolean;
    }>
  >`
    SELECT
      n.nspname                                   AS schema_name,
      t.relname                                   AS table_name,
      i.relname                                   AS index_name,
      ARRAY(
        SELECT pg_get_indexdef(idx.indexrelid, k + 1, true)
        FROM generate_subscripts(idx.indkey, 1) AS k
        ORDER BY k
      )                                           AS columns,
      idx.indisunique                             AS is_unique,
      idx.indisprimary                            AS is_primary,
      (idx.indpred IS NOT NULL)                   AS is_partial
    FROM pg_index idx
    JOIN pg_class i ON i.oid = idx.indexrelid
    JOIN pg_class t ON t.oid = idx.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = ${schema}
      AND t.relkind IN ('r', 'p')
    ORDER BY t.relname, i.relname
  `;
  return rows
    .filter((r) => !exclude.has(r.table_name))
    .map((r) => ({
      schemaName: r.schema_name,
      tableName: r.table_name,
      indexName: r.index_name,
      columns: r.columns,
      isUnique: r.is_unique,
      isPrimary: r.is_primary,
      isPartial: r.is_partial,
    }));
}

async function fetchIndexUsage(
  sql: Sql,
  schema: string,
  exclude: Set<string>,
): Promise<DbIndexUsage[]> {
  const rows = await sql<
    Array<{
      schema_name: string;
      table_name: string;
      index_name: string;
      idx_scan: number;
      seq_scan: number;
      reltuples: number;
    }>
  >`
    SELECT
      sui.schemaname                              AS schema_name,
      sui.relname                                 AS table_name,
      sui.indexrelname                            AS index_name,
      sui.idx_scan                                AS idx_scan,
      COALESCE(sut.seq_scan, 0)                   AS seq_scan,
      COALESCE(c.reltuples, 0)::bigint            AS reltuples
    FROM pg_stat_user_indexes sui
    LEFT JOIN pg_stat_user_tables sut
      ON sut.schemaname = sui.schemaname AND sut.relname = sui.relname
    LEFT JOIN pg_class c
      ON c.oid = sui.indexrelid
    WHERE sui.schemaname = ${schema}
    ORDER BY sui.relname, sui.indexrelname
  `;
  return rows
    .filter((r) => !exclude.has(r.table_name))
    .map((r) => ({
      schemaName: r.schema_name,
      tableName: r.table_name,
      indexName: r.index_name,
      idxScan: Number(r.idx_scan),
      tableSeqScan: Number(r.seq_scan),
      approxRowCount: Number(r.reltuples),
    }));
}

async function fetchColumns(sql: Sql, schema: string, exclude: Set<string>): Promise<DbColumn[]> {
  const rows = await sql<
    Array<{
      table_schema: string;
      table_name: string;
      column_name: string;
      data_type: string;
      udt_name: string;
      is_nullable: string;
      character_maximum_length: number | null;
      column_default: string | null;
    }>
  >`
    SELECT
      table_schema,
      table_name,
      column_name,
      data_type,
      udt_name,
      is_nullable,
      character_maximum_length,
      column_default
    FROM information_schema.columns
    WHERE table_schema = ${schema}
    ORDER BY table_name, ordinal_position
  `;
  return rows
    .filter((r) => !exclude.has(r.table_name))
    .map((r) => ({
      schemaName: r.table_schema,
      tableName: r.table_name,
      columnName: r.column_name,
      dataType: r.data_type,
      udtName: r.udt_name,
      isNullable: r.is_nullable === "YES",
      characterMaximumLength: r.character_maximum_length,
      columnDefault: r.column_default,
    }));
}

interface PgForeignKeyRow {
  schema_name: string;
  table_name: string;
  constraint_name: string;
  /** Postgres action codes. See `pg_constraint.confdeltype` / `confupdtype`. */
  on_delete_code: string;
  on_update_code: string;
  /** Source columns in the order they were declared in the constraint. */
  columns: string[];
  referenced_table: string;
  /** Referenced columns parallel to `columns`. */
  referenced_columns: string[];
}

async function fetchForeignKeys(
  sql: Sql,
  schema: string,
  exclude: Set<string>,
): Promise<DbForeignKey[]> {
  // pg_constraint.contype = 'f' is FK. We pull the source/target column names
  // by joining pg_attribute through pg_constraint.conkey (source attnums) and
  // confkey (target attnums). Both arrays preserve declaration order, which we
  // preserve by reconstructing per-position via array_position.
  const rows = await sql<PgForeignKeyRow[]>`
    SELECT
      n.nspname                                                AS schema_name,
      cls.relname                                              AS table_name,
      con.conname                                              AS constraint_name,
      con.confdeltype                                          AS on_delete_code,
      con.confupdtype                                          AS on_update_code,
      ARRAY(
        SELECT a.attname
        FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
        JOIN pg_attribute a
          ON a.attrelid = con.conrelid AND a.attnum = k.attnum
        ORDER BY k.ord
      )                                                        AS columns,
      fcls.relname                                             AS referenced_table,
      ARRAY(
        SELECT a.attname
        FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, ord)
        JOIN pg_attribute a
          ON a.attrelid = con.confrelid AND a.attnum = k.attnum
        ORDER BY k.ord
      )                                                        AS referenced_columns
    FROM pg_constraint con
    JOIN pg_class cls       ON cls.oid = con.conrelid
    JOIN pg_namespace n     ON n.oid = cls.relnamespace
    JOIN pg_class fcls      ON fcls.oid = con.confrelid
    WHERE con.contype = 'f'
      AND n.nspname = ${schema}
    ORDER BY cls.relname, con.conname
  `;

  return mapPostgresForeignKeyRows(rows, exclude);
}

/**
 * Pure mapping — exposed for unit tests. Translates Postgres action codes
 * (`pg_constraint.confdeltype` / `confupdtype`) into the normalized vocabulary
 * defined by `ForeignKeyAction`.
 *
 * Postgres codes:
 *   `a` → no action (default)   `r` → restrict   `c` → cascade
 *   `n` → set null              `d` → set default
 */
export function mapPostgresForeignKeyRows(
  rows: PgForeignKeyRow[],
  exclude: Set<string>,
): DbForeignKey[] {
  return rows
    .filter((r) => !exclude.has(r.table_name))
    .map((r) => ({
      schemaName: r.schema_name,
      tableName: r.table_name,
      constraintName: r.constraint_name,
      columns: r.columns,
      referencedTable: r.referenced_table,
      referencedColumns: r.referenced_columns,
      onDelete: pgActionFromCode(r.on_delete_code),
      onUpdate: pgActionFromCode(r.on_update_code),
    }));
}

function pgActionFromCode(code: string): ForeignKeyAction {
  switch (code) {
    case "c":
      return "cascade";
    case "r":
      return "restrict";
    case "n":
      return "set null";
    case "d":
      return "set default";
    default:
      // 'a' or anything unknown — Postgres documents 'a' as NO ACTION (the
      // default), and we conservatively bucket unknown codes there too. Better
      // to under-report drift than synthesize a wrong action.
      return "no action";
  }
}
