/**
 * Postgres adapter for Group B (live-DB) rules.
 *
 * Only this module imports `postgres`. Everything downstream consumes the
 * pure data shapes in `types.ts`, so rule logic can be unit-tested with
 * fixture data instead of a live Postgres connection.
 */

import postgres from "postgres";
import type { DbColumn, DbIndex, DbIndexUsage, DbSnapshot } from "./types.js";

export interface DbConnectOptions {
  /** Connection string — typically `process.env.DATABASE_URL`. */
  url: string;
  /** Schema to introspect. Defaults to `public`. */
  schema?: string;
  /** Tables to skip entirely (e.g. internal Prisma migration tables). */
  excludeTables?: string[];
}

const DEFAULT_EXCLUDE_TABLES = ["_prisma_migrations"];

export async function snapshotDatabase(opts: DbConnectOptions): Promise<DbSnapshot> {
  const sql = postgres(opts.url, {
    onnotice: () => {}, // suppress NOTICE noise
    max: 1,
  });
  const schema = opts.schema ?? "public";
  const excludeTables = new Set([...DEFAULT_EXCLUDE_TABLES, ...(opts.excludeTables ?? [])]);

  try {
    const [indexes, indexUsage, columns] = await Promise.all([
      fetchIndexes(sql, schema, excludeTables),
      fetchIndexUsage(sql, schema, excludeTables),
      fetchColumns(sql, schema, excludeTables),
    ]);
    return { indexes, indexUsage, columns };
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
    }>
  >`
    SELECT
      table_schema,
      table_name,
      column_name,
      data_type,
      udt_name,
      is_nullable,
      character_maximum_length
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
    }));
}
