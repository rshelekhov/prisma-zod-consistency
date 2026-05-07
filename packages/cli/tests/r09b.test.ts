/**
 * R09b — type drift between Prisma `@db.*` and live DB columns.
 *
 * The pure mapping (`expectedColumnFor`) is exhaustively unit-tested across
 * Prisma scalar × `@db.*` × provider combinations so future provider work
 * can extend the table with confidence.
 *
 * Integration tests for `diffTypes` exercise the rule against synthetic
 * `DbColumn[]` data with hand-crafted `PrismaModelRegistry` entries — same
 * pattern as `group-b.test.ts` for R09.
 */

import { describe, expect, it } from "vitest";
import type { DbColumn } from "../src/db/types.js";
import { diffTypes } from "../src/rules/r09b-type-drift.js";
import type { FieldInfo, PrismaModelRegistry } from "../src/schema/prisma-models.js";
import { compareTypes, expectedColumnFor } from "../src/schema/prisma-type-map.js";

describe("expectedColumnFor — Prisma scalar → provider type mapping", () => {
  it("maps String + @db.VarChar(N) per provider", () => {
    const f = field("name", "String", { dbAttribute: { kind: "VarChar", size: 100 } });
    expect(expectedColumnFor(f, "postgresql")).toMatchObject({
      udtName: "varchar",
      dataType: "character varying",
      characterMaximumLength: 100,
    });
    expect(expectedColumnFor(f, "mysql")).toMatchObject({
      udtName: "varchar",
      characterMaximumLength: 100,
    });
    // SQLite: length not enforced — we don't pin a length on the expected shape.
    expect(expectedColumnFor(f, "sqlite")).toMatchObject({
      udtName: "text",
      characterMaximumLength: null,
    });
  });

  it("maps String with no @db.* per provider's default", () => {
    const f = field("bio", "String", {});
    expect(expectedColumnFor(f, "postgresql")?.udtName).toBe("text");
    // Prisma defaults String → varchar(191) on MySQL for index-friendliness.
    expect(expectedColumnFor(f, "mysql")).toMatchObject({
      udtName: "varchar",
      characterMaximumLength: 191,
    });
    expect(expectedColumnFor(f, "sqlite")?.udtName).toBe("text");
  });

  it("maps Int (default) and Int @db.SmallInt", () => {
    const i = field("count", "Int", {});
    expect(expectedColumnFor(i, "postgresql")?.udtName).toBe("int4");
    expect(expectedColumnFor(i, "mysql")?.udtName).toBe("int");

    const small = field("rank", "Int", { dbAttribute: { kind: "SmallInt" } });
    expect(expectedColumnFor(small, "postgresql")?.udtName).toBe("int2");
    expect(expectedColumnFor(small, "mysql")?.udtName).toBe("smallint");
  });

  it("maps BigInt and Boolean per provider conventions", () => {
    const big = field("ms", "BigInt", {});
    expect(expectedColumnFor(big, "postgresql")?.udtName).toBe("int8");
    expect(expectedColumnFor(big, "mysql")?.udtName).toBe("bigint");

    const bool = field("active", "Boolean", {});
    expect(expectedColumnFor(bool, "postgresql")?.udtName).toBe("bool");
    // MySQL Boolean → tinyint(1).
    expect(expectedColumnFor(bool, "mysql")?.udtName).toBe("tinyint");
  });

  it("maps DateTime defaults and Timestamptz override", () => {
    const dt = field("createdAt", "DateTime", {});
    expect(expectedColumnFor(dt, "postgresql")?.udtName).toBe("timestamp");
    expect(expectedColumnFor(dt, "mysql")?.udtName).toBe("datetime");

    const tz = field("createdAt", "DateTime", { dbAttribute: { kind: "Timestamptz" } });
    expect(expectedColumnFor(tz, "postgresql")?.udtName).toBe("timestamptz");
  });

  it("maps Float and Decimal", () => {
    const f = field("score", "Float", {});
    expect(expectedColumnFor(f, "postgresql")?.udtName).toBe("float8");
    expect(expectedColumnFor(f, "mysql")?.udtName).toBe("double");

    const d = field("price", "Decimal", { dbAttribute: { kind: "Decimal" } });
    expect(expectedColumnFor(d, "postgresql")?.udtName).toBe("numeric");
    expect(expectedColumnFor(d, "mysql")?.udtName).toBe("decimal");
  });

  it("maps Bytes and Json", () => {
    const b = field("payload", "Bytes", {});
    expect(expectedColumnFor(b, "postgresql")?.udtName).toBe("bytea");
    expect(expectedColumnFor(b, "mysql")?.udtName).toBe("longblob");

    const j = field("metadata", "Json", {});
    expect(expectedColumnFor(j, "postgresql")?.udtName).toBe("jsonb");
    expect(expectedColumnFor(j, "mysql")?.udtName).toBe("json");
  });

  it("returns null for array fields and unknown scalars", () => {
    const arr = field("tags", "String", { isArray: true });
    expect(expectedColumnFor(arr, "postgresql")).toBe(null);

    const custom = field("status", "MyEnumType", {});
    expect(expectedColumnFor(custom, "postgresql")).toBe(null);
  });
});

describe("compareTypes — verdicts for Postgres / MySQL / SQLite", () => {
  it("returns match when udtName aligns and length matches", () => {
    const expected = {
      provider: "postgresql" as const,
      udtName: "varchar",
      dataType: "character varying",
      characterMaximumLength: 100,
    };
    expect(compareTypes(expected, dbCol({ udtName: "varchar", characterMaximumLength: 100 }))).toBe(
      "match",
    );
  });

  it("returns drift when udtName diverges", () => {
    const expected = {
      provider: "postgresql" as const,
      udtName: "int4",
      dataType: "integer",
      characterMaximumLength: null,
    };
    expect(compareTypes(expected, dbCol({ udtName: "int8" }))).toBe("drift");
  });

  it("returns drift when length differs", () => {
    const expected = {
      provider: "postgresql" as const,
      udtName: "varchar",
      dataType: "character varying",
      characterMaximumLength: 100,
    };
    expect(compareTypes(expected, dbCol({ udtName: "varchar", characterMaximumLength: 255 }))).toBe(
      "drift",
    );
  });

  it("folds Postgres synonyms (character varying ↔ varchar, integer ↔ int4, etc.)", () => {
    const expected = {
      provider: "postgresql" as const,
      udtName: "int4",
      dataType: "integer",
      characterMaximumLength: null,
    };
    // Some Postgres metadata reports `integer` for udt_name in older versions.
    expect(compareTypes(expected, dbCol({ udtName: "integer" }))).toBe("match");
  });

  it("returns incomparable on SQLite when declared types differ (avoids false-positive noise)", () => {
    const expected = {
      provider: "sqlite" as const,
      udtName: "text",
      dataType: "text",
      characterMaximumLength: null,
    };
    expect(compareTypes(expected, dbCol({ udtName: "varchar" }))).toBe("incomparable");
  });
});

describe("R09b.diffTypes — integration", () => {
  it("flags a varchar(100) ↔ varchar(255) drift on Postgres", () => {
    const registry = makeRegistry({
      User: [field("email", "String", { dbAttribute: { kind: "VarChar", size: 100 } })],
    });
    const dbColumns: DbColumn[] = [
      dbCol({
        tableName: "User",
        columnName: "email",
        udtName: "varchar",
        dataType: "character varying",
        characterMaximumLength: 255,
      }),
    ];
    const findings = diffTypes(registry, dbColumns, "postgresql", opts());
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("Type drift");
    expect(findings[0]?.message).toContain("email");
    // Prisma side preserves Prisma's `VarChar(N)` spelling; DB side reports
    // lowercase `varchar(255)`. Both should be in the message so the user
    // sees both perspectives.
    expect(findings[0]?.message).toContain("VarChar(100)");
    expect(findings[0]?.message).toContain("varchar(255)");
  });

  it("flags Int → bigint drift", () => {
    const registry = makeRegistry({ Stat: [field("count", "Int", {})] });
    const dbColumns: DbColumn[] = [
      dbCol({
        tableName: "Stat",
        columnName: "count",
        udtName: "int8",
        dataType: "bigint",
      }),
    ];
    const findings = diffTypes(registry, dbColumns, "postgresql", opts());
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("Stat.count");
  });

  it("does not flag matching shapes", () => {
    const registry = makeRegistry({
      User: [field("email", "String", { dbAttribute: { kind: "VarChar", size: 100 } })],
    });
    const dbColumns: DbColumn[] = [
      dbCol({
        tableName: "User",
        columnName: "email",
        udtName: "varchar",
        dataType: "character varying",
        characterMaximumLength: 100,
      }),
    ];
    expect(diffTypes(registry, dbColumns, "postgresql", opts())).toEqual([]);
  });

  it("respects ignoreColumns regex", () => {
    const registry = makeRegistry({
      User: [field("legacy_id", "Int", {})],
    });
    const dbColumns: DbColumn[] = [
      dbCol({
        tableName: "User",
        columnName: "legacy_id",
        udtName: "int8",
        dataType: "bigint",
      }),
    ];
    const findings = diffTypes(registry, dbColumns, "postgresql", {
      severity: "warning",
      config: { ignoreColumns: ["^legacy_"] },
    });
    expect(findings).toEqual([]);
  });

  it("respects ignoreTables", () => {
    const registry = makeRegistry({
      _prisma_migrations: [field("col", "Int", {})],
    });
    const dbColumns: DbColumn[] = [
      dbCol({
        tableName: "_prisma_migrations",
        columnName: "col",
        udtName: "int8",
        dataType: "bigint",
      }),
    ];
    const findings = diffTypes(registry, dbColumns, "postgresql", {
      severity: "warning",
      config: { ignoreTables: ["_prisma_migrations"] },
    });
    expect(findings).toEqual([]);
  });

  it("skips relation fields (those are R09's territory)", () => {
    const registry: PrismaModelRegistry = {
      models: new Map([
        [
          "Post",
          {
            name: "Post",
            tableName: "Post",
            fields: [
              field("authorId", "Int", {}),
              // `author` field references another model — relation, must be skipped.
              {
                name: "author",
                type: "User",
                isArray: false,
                isOptional: false,
                attributes: [],
                columnName: "author",
              },
            ],
          },
        ],
        ["User", { name: "User", tableName: "User", fields: [field("id", "Int", {})] }],
      ]),
      enums: new Map(),
    };
    const dbColumns: DbColumn[] = [
      dbCol({
        tableName: "Post",
        columnName: "authorId",
        udtName: "int4",
        dataType: "integer",
      }),
    ];
    expect(diffTypes(registry, dbColumns, "postgresql", opts())).toEqual([]);
  });
});

// ---- helpers ----

function field(
  name: string,
  type: string,
  p: {
    isArray?: boolean;
    isOptional?: boolean;
    dbAttribute?: { kind: string; size?: number };
  },
): FieldInfo {
  return {
    name,
    type,
    isArray: p.isArray ?? false,
    isOptional: p.isOptional ?? false,
    attributes: [],
    columnName: name,
    ...(p.dbAttribute
      ? {
          dbAttribute: {
            kind: p.dbAttribute.kind,
            ...(p.dbAttribute.size !== undefined ? { size: p.dbAttribute.size } : {}),
          },
        }
      : {}),
  };
}

function dbCol(p: Partial<DbColumn>): DbColumn {
  return {
    schemaName: "public",
    tableName: "users",
    columnName: "x",
    dataType: "text",
    udtName: "text",
    isNullable: false,
    characterMaximumLength: null,
    columnDefault: null,
    ...p,
  };
}

function opts() {
  return { severity: "warning" as const, config: {} };
}

function makeRegistry(spec: Record<string, FieldInfo[]>): PrismaModelRegistry {
  const models = new Map();
  for (const [modelName, fields] of Object.entries(spec)) {
    models.set(modelName, { name: modelName, tableName: modelName, fields });
  }
  return { models, enums: new Map() };
}
