/**
 * SQLite adapter for Group B (live-DB) rules.
 *
 * Uses `better-sqlite3` (synchronous API, native bindings). Because
 * `better-sqlite3` is an optional peer dep, this module is loaded dynamically
 * by `db/index.ts`; the only compile-time reference is a `import type ...`
 * which tsc strips from emit.
 *
 * ## Capability differences vs Postgres / MySQL
 *
 * - **Index usage statistics:** SQLite does not track per-index read counts
 *   anywhere — there is no `pg_stat_user_indexes` equivalent and no
 *   `performance_schema`. We return `indexUsage: []` and
 *   `capabilities.indexUsageTracking = false`. R08 (unused indexes) silently
 *   skips when this flag is `false`.
 * - **PK on rowid:** for ordinary `INTEGER PRIMARY KEY` tables SQLite stores
 *   the PK as `rowid` and does not surface it via `PRAGMA index_list`. R07
 *   (redundant indexes) is unaffected (it never flags PKs anyway). R09 reads
 *   PK presence from `PRAGMA table_info(...)` instead.
 * - **Length constraints:** SQLite's column types are affinities; declared
 *   lengths like `VARCHAR(100)` are not enforced. We surface `dataType` as the
 *   declared text lowercased for diagnostics, but
 *   `characterMaximumLength` is always `null`. R09b (type drift) will not be
 *   able to compare lengths on SQLite.
 *
 * ## URL format
 *
 * Prisma's SQLite datasource URL is `file:./relative.db` or `file:/abs.db`.
 * We strip the `file:` prefix before opening. Prisma also supports
 * `file::memory:` for in-process testing — we honor that too.
 */

import type SqliteDatabase from "better-sqlite3";
import type {
  DbColumn,
  DbConnectOptions,
  DbForeignKey,
  DbIndex,
  DbSnapshot,
  ForeignKeyAction,
} from "./types.js";

const DEFAULT_EXCLUDE_TABLES = ["_prisma_migrations"];

/** Internal tables SQLite owns and we never want to surface to rules. */
const SQLITE_INTERNAL_PREFIX = "sqlite_";

interface IndexListRow {
  seq: number;
  name: string;
  unique: 0 | 1;
  origin: "c" | "u" | "pk"; // CREATE INDEX, UNIQUE constraint, primary key
  partial: 0 | 1;
}

interface IndexInfoRow {
  seqno: number;
  cid: number;
  name: string | null; // null for expression columns
}

interface TableInfoRow {
  cid: number;
  name: string;
  type: string;
  notnull: 0 | 1;
  dflt_value: string | null;
  pk: number;
}

/**
 * One row from `PRAGMA foreign_key_list(<table>)`. Multi-column FKs land as
 * multiple rows with the same `id` and ascending `seq` (column position).
 */
interface ForeignKeyListRow {
  id: number;
  seq: number;
  /** Referenced table name. */
  table: string;
  /** Source column on the table being introspected. */
  from: string;
  /** Referenced column. */
  to: string;
  on_update: string;
  on_delete: string;
  /** Match clause — we don't act on it, but PRAGMA returns it. */
  match: string;
}

export async function snapshotSqlite(opts: DbConnectOptions): Promise<DbSnapshot> {
  const Database = await loadDriver();
  const filename = parseSqliteUrl(opts.url);
  // Constructing the Database instance is where better-sqlite3 actually
  // touches its native binding. The JS shim resolves fine on `import()` even
  // when the .node file is missing — the failure surfaces here. Wrap with the
  // same actionable message we use for `import()` errors so users see one
  // consistent install hint instead of `bindings`-internal stack traces.
  let db: InstanceType<typeof Database>;
  try {
    db = new Database(filename, { readonly: true, fileMustExist: filename !== ":memory:" });
  } catch (err) {
    if (isMissingBindingError(err)) {
      throw new Error(
        `Group B rules need the 'better-sqlite3' native binding to be built for the current Node version, but it could not be located. Reinstall the package (it ships prebuilt binaries for common platforms): \`pnpm add -D better-sqlite3\` or \`npm i -D better-sqlite3\`. Original error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    throw err;
  }
  const excludeTables = new Set([...DEFAULT_EXCLUDE_TABLES, ...(opts.excludeTables ?? [])]);

  try {
    const indexes = fetchIndexes(db, excludeTables);
    const columns = fetchColumns(db, excludeTables);
    const foreignKeys = fetchForeignKeys(db, excludeTables);
    return {
      indexes,
      indexUsage: [], // SQLite does not track per-index usage; see file header.
      columns,
      foreignKeys,
      // SQLite type affinities make precise type comparison impossible —
      // declared `VARCHAR(100)` is not enforced and indistinguishable from
      // `varchar(255)` at the metadata level. R09b skips when this is false.
      capabilities: { indexUsageTracking: false, typeDriftAccurate: false },
    };
  } finally {
    db.close();
  }
}

/**
 * better-sqlite3 fails at `new Database(...)` with a "Could not locate the
 * bindings file" error from the `bindings` package when the prebuilt .node
 * file is missing for the current Node ABI. Detect that signature so we can
 * upgrade the message to something installable.
 */
function isMissingBindingError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /Could not locate the bindings file/i.test(err.message);
}

/**
 * Strip Prisma's `file:` prefix from the URL and resolve the resulting path.
 * The Prisma URL is relative to the schema.prisma directory at runtime; we
 * preserve the relative path here and let the caller's cwd resolve it. For
 * absolute paths and `:memory:` we pass through verbatim.
 */
function parseSqliteUrl(url: string): string {
  // Drop the `file:` scheme. Anything else (a raw path) is accepted as-is so
  // tests can pass `:memory:` or an absolute path directly.
  const stripped = url.startsWith("file:") ? url.slice("file:".length) : url;
  return stripped === "" ? ":memory:" : stripped;
}

type SqliteDb = InstanceType<typeof SqliteDatabase>;

function fetchIndexes(db: SqliteDb, exclude: Set<string>): DbIndex[] {
  // 1. List user tables (skip sqlite_* and the configured exclude list).
  const tables = db
    .prepare<[], { name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '${SQLITE_INTERNAL_PREFIX}%'`,
    )
    .all()
    .filter((t) => !exclude.has(t.name));

  const out: DbIndex[] = [];

  for (const { name: tableName } of tables) {
    // 2. List indexes per table. PRAGMA index_list returns autoindexes too,
    //    which we want — they correspond to UNIQUE constraints from the
    //    schema and matter for R07.
    const indexRows = db
      .prepare<[], IndexListRow>(`PRAGMA index_list(${quoteIdent(tableName)})`)
      .all();

    for (const ix of indexRows) {
      // 3. List columns per index, ordered by seqno (the index column order).
      const cols = db
        .prepare<[], IndexInfoRow>(`PRAGMA index_info(${quoteIdent(ix.name)})`)
        .all()
        .sort((a, b) => a.seqno - b.seqno)
        // Expression-column entries report null name. Drop them for now: R07
        // matches by literal column name, so we couldn't usefully report a
        // prefix relationship that involves an expression anyway.
        .map((c) => c.name)
        .filter((n): n is string => n !== null);

      out.push({
        schemaName: "main",
        tableName,
        indexName: ix.name,
        columns: cols,
        isUnique: ix.unique === 1,
        isPrimary: ix.origin === "pk",
        isPartial: ix.partial === 1,
      });
    }
  }

  return out;
}

function fetchColumns(db: SqliteDb, exclude: Set<string>): DbColumn[] {
  const tables = db
    .prepare<[], { name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '${SQLITE_INTERNAL_PREFIX}%'`,
    )
    .all()
    .filter((t) => !exclude.has(t.name));

  const out: DbColumn[] = [];

  for (const { name: tableName } of tables) {
    const rows = db.prepare<[], TableInfoRow>(`PRAGMA table_info(${quoteIdent(tableName)})`).all();

    for (const r of rows) {
      const declared = (r.type ?? "").toLowerCase();
      out.push({
        schemaName: "main",
        tableName,
        columnName: r.name,
        // SQLite has no formal "data_type" / "udt_name" split. We surface the
        // declared type for both fields so R09 / R09b can read either
        // consistently. Empty type is allowed in SQLite (BLOB affinity)
        // — leave as empty string rather than null.
        dataType: declared,
        udtName: declared,
        isNullable: r.notnull === 0,
        // Lengths are not enforced; nothing meaningful to surface.
        characterMaximumLength: null,
        // PRAGMA's `dflt_value` is the raw expression as written in
        // `CREATE TABLE` (already includes quotes for string literals). R09d
        // normalizes both sides before comparing.
        columnDefault: r.dflt_value,
      });
    }
  }

  return out;
}

function fetchForeignKeys(db: SqliteDb, exclude: Set<string>): DbForeignKey[] {
  // SQLite has no INFORMATION_SCHEMA equivalent for FKs; the canonical source
  // is `PRAGMA foreign_key_list(<table>)`, which we run per user table.
  const tables = db
    .prepare<[], { name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '${SQLITE_INTERNAL_PREFIX}%'`,
    )
    .all()
    .filter((t) => !exclude.has(t.name));

  const out: DbForeignKey[] = [];
  for (const { name: tableName } of tables) {
    const rows = db
      .prepare<[], ForeignKeyListRow>(`PRAGMA foreign_key_list(${quoteIdent(tableName)})`)
      .all();
    out.push(...groupSqliteForeignKeyRows(rows, tableName));
  }
  return out;
}

/**
 * Pure mapping — exposed for tests. Groups multi-column FK rows
 * (`PRAGMA foreign_key_list` returns one row per source column with the same
 * `id`) into single `DbForeignKey` entries.
 *
 * SQLite returns lowercased action text already (e.g. `"NO ACTION"`,
 * `"CASCADE"`); we still uppercase-normalize before mapping for robustness.
 *
 * Constraint names are not surfaced by SQLite — we synthesize a stable
 * synthetic name as `<table>_fk_<id>` so consumers get something to refer to.
 */
export function groupSqliteForeignKeyRows(
  rows: ForeignKeyListRow[],
  tableName: string,
): DbForeignKey[] {
  const byId = new Map<number, DbForeignKey>();
  // Sort by id then seq so we deterministically rebuild the column order even
  // if the PRAGMA returned rows out of order on some SQLite version.
  const ordered = [...rows].sort((a, b) => a.id - b.id || a.seq - b.seq);
  for (const r of ordered) {
    let entry = byId.get(r.id);
    if (!entry) {
      entry = {
        schemaName: "main",
        tableName,
        constraintName: `${tableName}_fk_${r.id}`,
        columns: [],
        referencedTable: r.table,
        referencedColumns: [],
        onDelete: sqliteActionFromText(r.on_delete),
        onUpdate: sqliteActionFromText(r.on_update),
      };
      byId.set(r.id, entry);
    }
    entry.columns.push(r.from);
    entry.referencedColumns.push(r.to);
  }
  return [...byId.values()];
}

function sqliteActionFromText(text: string): ForeignKeyAction {
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
      // "NO ACTION" / "" / unknown.
      return "no action";
  }
}

/**
 * Quote a SQLite identifier for use inside a PRAGMA. SQLite identifiers can
 * legally contain quotes if they're escaped by doubling, so we escape any
 * double quote in the input. PRAGMAs do not accept bound parameters, hence
 * literal interpolation — but the input here comes from `sqlite_master`, not
 * from user-controlled SQL.
 */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Dynamically import `better-sqlite3` and return its default export. If the
 * driver is missing we throw an actionable error pointing at the install
 * command — the dispatcher in `db/index.ts` re-throws this verbatim.
 */
async function loadDriver(): Promise<typeof SqliteDatabase> {
  try {
    const mod = await import("better-sqlite3");
    return mod.default;
  } catch (err) {
    throw new Error(
      `Group B rules need the 'better-sqlite3' package to introspect a SQLite database, but it is not installed. Install it as a dev dependency: \`pnpm add -D better-sqlite3\` (or \`npm i -D better-sqlite3\`). Original error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
