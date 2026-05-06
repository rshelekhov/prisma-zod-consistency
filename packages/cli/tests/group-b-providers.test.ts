/**
 * Provider-coverage tests for the Group B dispatch and the new MySQL / SQLite
 * adapters introduced in C1.
 *
 * Existing rule-logic tests in `group-b.test.ts` already cover R07/R08/R09
 * against synthetic `DbIndex[]` / `DbIndexUsage[]` / `DbColumn[]` data — those
 * stay provider-agnostic and don't need to be duplicated per engine.
 *
 * What this file covers:
 *   - The dispatcher's provider whitelist (isDbProviderSupported).
 *   - SQLite end-to-end snapshot against a real in-memory database (gives us
 *     a high-signal integration test without needing a daemon running).
 *   - MySQL pure-mapping functions, which is everything in mysql.ts that does
 *     interesting work — the SQL queries themselves are exercised by smoke
 *     against a real instance, not unit tests.
 *   - R08's capability-aware skip behavior.
 */

import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isDbProviderSupported } from "../src/db/index.js";
import {
  groupIndexRows,
  groupMysqlForeignKeyRows,
  mapColumnRows,
  mapUsageRows,
} from "../src/db/mysql.js";
import { mapPostgresForeignKeyRows } from "../src/db/postgres.js";
import { groupSqliteForeignKeyRows, snapshotSqlite } from "../src/db/sqlite.js";
import type { DbIndex, DbIndexUsage, DbSnapshot } from "../src/db/types.js";
import { r08 } from "../src/rules/r08-unused-indexes.js";
import type { ProjectContext } from "../src/types.js";

/**
 * Whether `better-sqlite3` has a working native binding in the current
 * environment. The package is an optional peer; in some sandboxed CI
 * environments the build step (node-gyp) and the prebuild fallback both fail
 * because of restricted outbound network. The end-to-end SQLite tests below
 * need a real binding, so we skip them when it's unavailable. On a
 * developer's machine and on GitHub Actions runners the binding will load
 * fine and the tests run normally.
 */
const sqliteAvailable: boolean = (() => {
  try {
    const probe = new Database(":memory:");
    probe.close();
    return true;
  } catch {
    return false;
  }
})();

describe("dispatch — isDbProviderSupported", () => {
  it("accepts the three providers we ship adapters for", () => {
    expect(isDbProviderSupported("postgresql")).toBe(true);
    expect(isDbProviderSupported("mysql")).toBe(true);
    expect(isDbProviderSupported("sqlite")).toBe(true);
  });

  it("rejects providers we don't yet introspect", () => {
    expect(isDbProviderSupported("sqlserver")).toBe(false);
    expect(isDbProviderSupported("mongodb")).toBe(false);
    expect(isDbProviderSupported("cockroachdb")).toBe(false);
  });
});

describe.skipIf(!sqliteAvailable)("SQLite adapter — end-to-end against a real on-disk DB", () => {
  // The adapter opens read-only, but writing the schema needs a separate
  // writer connection. better-sqlite3 doesn't share `:memory:` databases
  // across connections, so we use a temp file and clean up after.
  let tmpFile: string;

  beforeEach(() => {
    tmpFile = join(
      tmpdir(),
      `pz-c1-sqlite-${process.pid}-${Math.random().toString(36).slice(2, 8)}.sqlite`,
    );
  });

  afterEach(() => {
    try {
      unlinkSync(tmpFile);
    } catch {
      // already cleaned up or never created — ignore
    }
  });

  it("captures indexes, columns, and reports indexUsageTracking=false", async () => {
    const writer = new Database(tmpFile);
    writer.exec(`
      CREATE TABLE users (
        id      INTEGER PRIMARY KEY,
        email   TEXT NOT NULL,
        created TEXT
      );
      CREATE INDEX users_email_idx ON users(email);
      CREATE INDEX users_email_created_idx ON users(email, created);
      CREATE UNIQUE INDEX users_email_unique ON users(email);
    `);
    writer.close();

    const snap: DbSnapshot = await snapshotSqlite({ url: `file:${tmpFile}` });

    // Index assertions: we expect the two named indexes plus the unique we
    // created. The PK on rowid is intentionally not surfaced (see file
    // header in sqlite.ts).
    const indexNames = snap.indexes.map((i) => i.indexName).sort();
    expect(indexNames).toEqual(
      expect.arrayContaining(["users_email_idx", "users_email_created_idx", "users_email_unique"]),
    );

    const composite = snap.indexes.find((i) => i.indexName === "users_email_created_idx");
    expect(composite?.columns).toEqual(["email", "created"]);

    const unique = snap.indexes.find((i) => i.indexName === "users_email_unique");
    expect(unique?.isUnique).toBe(true);

    // Column assertions: all three columns of `users`, with notnull mapped to
    // isNullable. INTEGER PRIMARY KEY is nullable=false (it's effectively a
    // rowid alias).
    const userCols = snap.columns.filter((c) => c.tableName === "users");
    expect(userCols.map((c) => c.columnName).sort()).toEqual(["created", "email", "id"]);
    expect(userCols.find((c) => c.columnName === "email")?.isNullable).toBe(false);
    expect(userCols.find((c) => c.columnName === "created")?.isNullable).toBe(true);

    // Capability assertion: SQLite never tracks usage and is not type-precise.
    expect(snap.indexUsage).toEqual([]);
    expect(snap.capabilities.indexUsageTracking).toBe(false);
    expect(snap.capabilities.typeDriftAccurate).toBe(false);
    expect(snap.foreignKeys).toEqual([]); // no FK constraints in this fixture
  });

  it("captures column defaults from PRAGMA table_info", async () => {
    const writer = new Database(tmpFile);
    writer.exec(`
      CREATE TABLE posts (
        id      INTEGER PRIMARY KEY,
        title   TEXT NOT NULL,
        status  TEXT NOT NULL DEFAULT 'draft',
        views   INTEGER NOT NULL DEFAULT 0
      );
    `);
    writer.close();

    const snap: DbSnapshot = await snapshotSqlite({ url: `file:${tmpFile}` });
    const status = snap.columns.find((c) => c.tableName === "posts" && c.columnName === "status");
    const views = snap.columns.find((c) => c.tableName === "posts" && c.columnName === "views");
    const title = snap.columns.find((c) => c.tableName === "posts" && c.columnName === "title");
    // SQLite preserves the literal expression as written in CREATE TABLE,
    // including the surrounding quotes for string defaults.
    expect(status?.columnDefault).toBe("'draft'");
    expect(views?.columnDefault).toBe("0");
    expect(title?.columnDefault).toBe(null);
  });

  it("captures multi-column foreign keys via PRAGMA foreign_key_list", async () => {
    const writer = new Database(tmpFile);
    writer.exec(`
      CREATE TABLE org (
        id1 INTEGER NOT NULL,
        id2 INTEGER NOT NULL,
        PRIMARY KEY (id1, id2)
      );
      CREATE TABLE membership (
        id        INTEGER PRIMARY KEY,
        org_id1   INTEGER NOT NULL,
        org_id2   INTEGER NOT NULL,
        FOREIGN KEY (org_id1, org_id2) REFERENCES org(id1, id2)
          ON DELETE CASCADE ON UPDATE RESTRICT
      );
    `);
    writer.close();

    const snap: DbSnapshot = await snapshotSqlite({ url: `file:${tmpFile}` });
    const fks = snap.foreignKeys.filter((f) => f.tableName === "membership");
    expect(fks).toHaveLength(1);
    expect(fks[0]?.referencedTable).toBe("org");
    // PRAGMA foreign_key_list emits one row per source column. We expect them
    // grouped into a single FK with parallel column arrays in declaration order.
    expect(fks[0]?.columns).toEqual(["org_id1", "org_id2"]);
    expect(fks[0]?.referencedColumns).toEqual(["id1", "id2"]);
    expect(fks[0]?.onDelete).toBe("cascade");
    expect(fks[0]?.onUpdate).toBe("restrict");
  });

  it("excludes _prisma_migrations by default", async () => {
    const writer = new Database(tmpFile);
    writer.exec(`
      CREATE TABLE _prisma_migrations (id TEXT PRIMARY KEY);
      CREATE TABLE users (id INTEGER PRIMARY KEY);
    `);
    writer.close();

    const snap: DbSnapshot = await snapshotSqlite({ url: `file:${tmpFile}` });

    expect(snap.columns.some((c) => c.tableName === "_prisma_migrations")).toBe(false);
    expect(snap.columns.some((c) => c.tableName === "users")).toBe(true);
  });
});

describe("MySQL adapter — mapping functions", () => {
  // Simulate INFORMATION_SCHEMA.STATISTICS row stream (one row per
  // (index, column), ordered by SEQ_IN_INDEX).
  const indexRows = [
    {
      schema_name: "app",
      table_name: "users",
      index_name: "PRIMARY",
      column_name: "id",
      seq: 1,
      non_unique: 0 as const,
      index_type: "BTREE",
    },
    {
      schema_name: "app",
      table_name: "users",
      index_name: "users_email_idx",
      column_name: "email",
      seq: 1,
      non_unique: 1 as const,
      index_type: "BTREE",
    },
    {
      schema_name: "app",
      table_name: "users",
      index_name: "users_email_created_idx",
      column_name: "email",
      seq: 1,
      non_unique: 1 as const,
      index_type: "BTREE",
    },
    {
      schema_name: "app",
      table_name: "users",
      index_name: "users_email_created_idx",
      column_name: "created",
      seq: 2,
      non_unique: 1 as const,
      index_type: "BTREE",
    },
    {
      schema_name: "app",
      table_name: "_prisma_migrations",
      index_name: "PRIMARY",
      column_name: "id",
      seq: 1,
      non_unique: 0 as const,
      index_type: "BTREE",
    },
  ];

  it("groups (table, index) and preserves SEQ_IN_INDEX order", () => {
    const result = groupIndexRows(indexRows, new Set(["_prisma_migrations"]));
    const composite = result.find((i) => i.indexName === "users_email_created_idx");
    expect(composite?.columns).toEqual(["email", "created"]);
  });

  it("flags PRIMARY indexes as primary and unique", () => {
    const result = groupIndexRows(indexRows, new Set(["_prisma_migrations"]));
    const pk = result.find((i) => i.indexName === "PRIMARY");
    expect(pk?.isPrimary).toBe(true);
    expect(pk?.isUnique).toBe(true);
  });

  it("flags NON_UNIQUE=1 indexes as non-unique, non-primary", () => {
    const result = groupIndexRows(indexRows, new Set(["_prisma_migrations"]));
    const ix = result.find((i) => i.indexName === "users_email_idx");
    expect(ix?.isUnique).toBe(false);
    expect(ix?.isPrimary).toBe(false);
    expect(ix?.isPartial).toBe(false); // MySQL has no partial indexes
  });

  it("respects excludeTables", () => {
    const result = groupIndexRows(indexRows, new Set(["_prisma_migrations"]));
    expect(result.some((i) => i.tableName === "_prisma_migrations")).toBe(false);
  });

  it("drops null-column rows (functional/expression slots)", () => {
    const withNull = [
      ...indexRows,
      {
        schema_name: "app",
        table_name: "users",
        index_name: "users_func_idx",
        column_name: null,
        seq: 1,
        non_unique: 1 as const,
        index_type: "BTREE",
      },
    ];
    const result = groupIndexRows(withNull, new Set(["_prisma_migrations"]));
    expect(result.some((i) => i.indexName === "users_func_idx")).toBe(false);
  });

  it("mapUsageRows coerces NULL count_read to 0 and sets sentinel tableSeqScan", () => {
    const rows = [
      {
        schema_name: "app",
        table_name: "users",
        index_name: "users_email_idx",
        count_read: null,
        approx_rows: 50_000,
      },
      {
        schema_name: "app",
        table_name: "users",
        index_name: "users_active_idx",
        count_read: 12345,
        approx_rows: 50_000,
      },
    ];
    const result = mapUsageRows(rows, new Set());
    const cold = result.find((u) => u.indexName === "users_email_idx");
    expect(cold?.idxScan).toBe(0);
    expect(cold?.tableSeqScan).toBe(0); // dormant — R08 will not flag
    expect(cold?.approxRowCount).toBe(50_000);

    const hot = result.find((u) => u.indexName === "users_active_idx");
    expect(hot?.idxScan).toBe(12345);
    expect(hot?.tableSeqScan).toBe(1); // sentinel: table is alive
  });

  it("mapColumnRows maps IS_NULLABLE='YES'/'NO' and pulls character_maximum_length / column_default through", () => {
    const rows = [
      {
        schema_name: "app",
        table_name: "users",
        column_name: "email",
        data_type: "varchar",
        is_nullable: "NO" as const,
        character_maximum_length: 255,
        column_default: null,
      },
      {
        schema_name: "app",
        table_name: "users",
        column_name: "bio",
        data_type: "text",
        is_nullable: "YES" as const,
        character_maximum_length: null,
        column_default: null,
      },
      {
        schema_name: "app",
        table_name: "users",
        column_name: "status",
        data_type: "varchar",
        is_nullable: "NO" as const,
        character_maximum_length: 20,
        column_default: "'draft'",
      },
    ];
    const result = mapColumnRows(rows, new Set());
    const email = result.find((c) => c.columnName === "email");
    expect(email?.isNullable).toBe(false);
    expect(email?.characterMaximumLength).toBe(255);
    expect(email?.dataType).toBe("varchar");
    expect(email?.udtName).toBe("varchar");
    expect(email?.columnDefault).toBe(null);

    const bio = result.find((c) => c.columnName === "bio");
    expect(bio?.isNullable).toBe(true);
    expect(bio?.characterMaximumLength).toBe(null);

    const status = result.find((c) => c.columnName === "status");
    expect(status?.columnDefault).toBe("'draft'");
  });
});

describe("Postgres adapter — FK action code translation", () => {
  // Postgres reports FK actions as single-character codes
  // (`pg_constraint.confdeltype` / `confupdtype`). We normalize them to the
  // SQL-standard vocabulary so R09c can compare against Prisma `@relation` text.
  it("maps single-character codes to the normalized vocabulary", () => {
    const rows = [
      {
        schema_name: "public",
        table_name: "membership",
        constraint_name: "membership_org_id_fkey",
        on_delete_code: "c",
        on_update_code: "r",
        columns: ["org_id"],
        referenced_table: "org",
        referenced_columns: ["id"],
      },
      {
        schema_name: "public",
        table_name: "comment",
        constraint_name: "comment_post_id_fkey",
        on_delete_code: "n",
        on_update_code: "a",
        columns: ["post_id"],
        referenced_table: "post",
        referenced_columns: ["id"],
      },
      {
        schema_name: "public",
        table_name: "audit",
        constraint_name: "audit_actor_id_fkey",
        on_delete_code: "d",
        on_update_code: "x", // unknown — should bucket into "no action"
        columns: ["actor_id"],
        referenced_table: "user",
        referenced_columns: ["id"],
      },
    ];
    const result = mapPostgresForeignKeyRows(rows, new Set());
    expect(result.find((r) => r.constraintName === "membership_org_id_fkey")?.onDelete).toBe(
      "cascade",
    );
    expect(result.find((r) => r.constraintName === "membership_org_id_fkey")?.onUpdate).toBe(
      "restrict",
    );
    const comment = result.find((r) => r.constraintName === "comment_post_id_fkey");
    expect(comment?.onDelete).toBe("set null");
    expect(comment?.onUpdate).toBe("no action");
    const audit = result.find((r) => r.constraintName === "audit_actor_id_fkey");
    expect(audit?.onDelete).toBe("set default");
    expect(audit?.onUpdate).toBe("no action"); // unknown → conservative fallback
  });

  it("respects excludeTables", () => {
    const rows = [
      {
        schema_name: "public",
        table_name: "_prisma_migrations",
        constraint_name: "ignored_fkey",
        on_delete_code: "c",
        on_update_code: "c",
        columns: ["x"],
        referenced_table: "y",
        referenced_columns: ["id"],
      },
    ];
    const result = mapPostgresForeignKeyRows(rows, new Set(["_prisma_migrations"]));
    expect(result).toEqual([]);
  });
});

describe("MySQL adapter — FK row grouping", () => {
  // KEY_COLUMN_USAGE returns one row per source column; multi-column FKs share
  // a constraint_name and ascend by ordinal_position. The mapping function has
  // to rebuild parallel `columns` / `referencedColumns` arrays in order.
  it("groups multi-column FK rows in ordinal_position order", () => {
    const rows = [
      {
        schema_name: "app",
        table_name: "membership",
        constraint_name: "membership_org_fk",
        column_name: "org_id1",
        ordinal_position: 1,
        referenced_table: "org",
        referenced_column: "id1",
        delete_rule: "CASCADE",
        update_rule: "NO ACTION",
      },
      {
        schema_name: "app",
        table_name: "membership",
        constraint_name: "membership_org_fk",
        column_name: "org_id2",
        ordinal_position: 2,
        referenced_table: "org",
        referenced_column: "id2",
        delete_rule: "CASCADE",
        update_rule: "NO ACTION",
      },
    ];
    const result = groupMysqlForeignKeyRows(rows, new Set());
    expect(result).toHaveLength(1);
    expect(result[0]?.columns).toEqual(["org_id1", "org_id2"]);
    expect(result[0]?.referencedColumns).toEqual(["id1", "id2"]);
    expect(result[0]?.onDelete).toBe("cascade");
    expect(result[0]?.onUpdate).toBe("no action");
  });

  it("translates DELETE_RULE / UPDATE_RULE text into the normalized vocabulary", () => {
    const make = (deleteRule: string, updateRule: string) => ({
      schema_name: "app",
      table_name: "t",
      constraint_name: `c_${deleteRule}_${updateRule}`,
      column_name: "x",
      ordinal_position: 1,
      referenced_table: "y",
      referenced_column: "id",
      delete_rule: deleteRule,
      update_rule: updateRule,
    });
    const result = groupMysqlForeignKeyRows(
      [
        make("RESTRICT", "SET NULL"),
        make("SET DEFAULT", "CASCADE"),
        make("NO ACTION", "WHATEVER"), // unknown → "no action"
      ],
      new Set(),
    );
    expect(result.find((r) => r.constraintName === "c_RESTRICT_SET NULL")?.onDelete).toBe(
      "restrict",
    );
    expect(result.find((r) => r.constraintName === "c_RESTRICT_SET NULL")?.onUpdate).toBe(
      "set null",
    );
    expect(result.find((r) => r.constraintName === "c_SET DEFAULT_CASCADE")?.onDelete).toBe(
      "set default",
    );
    expect(result.find((r) => r.constraintName === "c_NO ACTION_WHATEVER")?.onUpdate).toBe(
      "no action",
    );
  });
});

describe("SQLite adapter — FK row grouping", () => {
  // PRAGMA foreign_key_list returns one row per source column. Each FK has its
  // own `id`; multi-column FKs share id with seq=0..N-1.
  it("groups multi-column FK rows by id, preserving seq order", () => {
    const rows = [
      // Intentionally out-of-order to exercise the sort.
      {
        id: 0,
        seq: 1,
        table: "org",
        from: "org_id2",
        to: "id2",
        on_update: "RESTRICT",
        on_delete: "CASCADE",
        match: "NONE",
      },
      {
        id: 0,
        seq: 0,
        table: "org",
        from: "org_id1",
        to: "id1",
        on_update: "RESTRICT",
        on_delete: "CASCADE",
        match: "NONE",
      },
      {
        id: 1,
        seq: 0,
        table: "user",
        from: "actor_id",
        to: "id",
        on_update: "NO ACTION",
        on_delete: "SET NULL",
        match: "NONE",
      },
    ];
    const result = groupSqliteForeignKeyRows(rows, "membership");
    expect(result).toHaveLength(2);
    const composite = result.find((f) => f.referencedTable === "org");
    expect(composite?.columns).toEqual(["org_id1", "org_id2"]);
    expect(composite?.referencedColumns).toEqual(["id1", "id2"]);
    expect(composite?.onDelete).toBe("cascade");
    expect(composite?.onUpdate).toBe("restrict");
    expect(composite?.constraintName).toBe("membership_fk_0");

    const single = result.find((f) => f.referencedTable === "user");
    expect(single?.onDelete).toBe("set null");
    expect(single?.onUpdate).toBe("no action");
  });
});

describe("R08 — capability-aware skip", () => {
  it("returns [] when the provider doesn't track index usage", async () => {
    const ctx = projectCtxWithDb({
      indexes: [
        {
          schemaName: "main",
          tableName: "users",
          indexName: "users_email_idx",
          columns: ["email"],
          isUnique: false,
          isPrimary: false,
          isPartial: false,
        },
      ],
      indexUsage: [],
      columns: [],
      foreignKeys: [],
      capabilities: { indexUsageTracking: false, typeDriftAccurate: false }, // SQLite-style
    });
    const findings = await r08.run(ctx, { severity: "info", config: {} });
    expect(findings).toEqual([]);
  });

  it("runs normally when the provider does track index usage", async () => {
    const indexes: DbIndex[] = [
      {
        schemaName: "public",
        tableName: "users",
        indexName: "users_email_idx",
        columns: ["email"],
        isUnique: false,
        isPrimary: false,
        isPartial: false,
      },
    ];
    const indexUsage: DbIndexUsage[] = [
      {
        schemaName: "public",
        tableName: "users",
        indexName: "users_email_idx",
        idxScan: 0,
        tableSeqScan: 100,
        approxRowCount: 50_000,
      },
    ];
    const ctx = projectCtxWithDb({
      indexes,
      indexUsage,
      columns: [],
      foreignKeys: [],
      capabilities: { indexUsageTracking: true, typeDriftAccurate: true },
    });
    const findings = await r08.run(ctx, { severity: "info", config: {} });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("users_email_idx");
  });
});

// ---- helpers ----

function projectCtxWithDb(snapshot: DbSnapshot): ProjectContext {
  return {
    rootDir: "/fake",
    schemaPath: "/fake/schema.prisma",
    provider: "sqlite",
    sourceFiles: [],
    zodMode: { kind: "hand-written" },
    db: snapshot,
  };
}
