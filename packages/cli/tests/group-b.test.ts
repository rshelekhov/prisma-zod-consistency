import { describe, expect, it } from "vitest";
import type { DbColumn, DbIndex, DbIndexUsage } from "../src/db/types.js";
import { findRedundancies } from "../src/rules/r07-redundant-indexes.js";
import { findUnused } from "../src/rules/r08-unused-indexes.js";
import { diffPrismaVsDb } from "../src/rules/r09-schema-drift-vs-db.js";
import type { PrismaModelRegistry } from "../src/schema/prisma-models.js";

describe("R07 — redundant indexes", () => {
  it("flags a narrow index whose columns are a strict prefix of a wider one", () => {
    const indexes: DbIndex[] = [
      idx({ indexName: "users_email_idx", columns: ["email"] }),
      idx({ indexName: "users_email_created_idx", columns: ["email", "created_at"] }),
    ];
    const findings = findRedundancies(indexes, opts());
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("users_email_idx");
    expect(findings[0]?.message).toContain("users_email_created_idx");
  });

  it("does not flag a unique narrow index when the wider one is non-unique", () => {
    const indexes: DbIndex[] = [
      idx({ indexName: "users_email_uidx", columns: ["email"], isUnique: true }),
      idx({ indexName: "users_email_created_idx", columns: ["email", "created_at"] }),
    ];
    const findings = findRedundancies(indexes, opts());
    expect(findings).toEqual([]);
  });

  it("ignores partial indexes", () => {
    const indexes: DbIndex[] = [
      idx({ indexName: "users_active_email_idx", columns: ["email"], isPartial: true }),
      idx({ indexName: "users_email_created_idx", columns: ["email", "created_at"] }),
    ];
    const findings = findRedundancies(indexes, opts());
    expect(findings).toEqual([]);
  });
});

describe("R08 — unused indexes", () => {
  it("flags idx_scan=0 with seq_scan>0 on a large table", () => {
    const indexes: DbIndex[] = [idx({ indexName: "users_email_idx", columns: ["email"] })];
    const usage: DbIndexUsage[] = [
      use({ indexName: "users_email_idx", idxScan: 0, tableSeqScan: 100, approxRowCount: 50_000 }),
    ];
    const findings = findUnused(indexes, usage, opts());
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("users_email_idx");
  });

  it("does not flag tiny tables", () => {
    const indexes: DbIndex[] = [idx({ indexName: "settings_key_idx", columns: ["key"] })];
    const usage: DbIndexUsage[] = [
      use({ indexName: "settings_key_idx", idxScan: 0, tableSeqScan: 100, approxRowCount: 50 }),
    ];
    const findings = findUnused(indexes, usage, opts());
    expect(findings).toEqual([]);
  });

  it("does not flag dormant tables (seq_scan=0)", () => {
    const indexes: DbIndex[] = [idx({ indexName: "audit_idx", columns: ["created_at"] })];
    const usage: DbIndexUsage[] = [
      use({ indexName: "audit_idx", idxScan: 0, tableSeqScan: 0, approxRowCount: 1_000_000 }),
    ];
    const findings = findUnused(indexes, usage, opts());
    expect(findings).toEqual([]);
  });
});

describe("R09 — schema drift vs DB", () => {
  it("flags a column declared in Prisma but missing in the DB", () => {
    const registry = makeRegistry({
      User: { id: { type: "String" }, email: { type: "String" } },
    });
    const dbColumns: DbColumn[] = [
      col({ tableName: "user", columnName: "id", isNullable: false }),
    ];
    const findings = diffPrismaVsDb(registry, dbColumns, opts());
    expect(
      findings.some((f) => f.message.includes("email") && f.message.includes("missing in the database")),
    ).toBe(true);
  });

  it("flags a column in the DB that's not in Prisma", () => {
    const registry = makeRegistry({
      User: { id: { type: "String" } },
    });
    const dbColumns: DbColumn[] = [
      col({ tableName: "user", columnName: "id", isNullable: false }),
      col({ tableName: "user", columnName: "legacy_flag", isNullable: true }),
    ];
    const findings = diffPrismaVsDb(registry, dbColumns, opts());
    expect(
      findings.some((f) => f.message.includes("legacy_flag") && f.message.includes("not declared in schema.prisma")),
    ).toBe(true);
  });

  it("flags nullability drift", () => {
    const registry = makeRegistry({
      User: { id: { type: "String" }, name: { type: "String", isOptional: true } },
    });
    const dbColumns: DbColumn[] = [
      col({ tableName: "user", columnName: "id", isNullable: false }),
      col({ tableName: "user", columnName: "name", isNullable: false }),
    ];
    const findings = diffPrismaVsDb(registry, dbColumns, opts());
    expect(
      findings.some((f) => f.message.includes("Nullability drift") && f.message.includes("name")),
    ).toBe(true);
  });
});

// ---- helpers ----

function idx(p: Partial<DbIndex>): DbIndex {
  return {
    schemaName: "public",
    tableName: "users",
    indexName: "idx",
    columns: [],
    isUnique: false,
    isPrimary: false,
    isPartial: false,
    ...p,
  };
}

function use(p: Partial<DbIndexUsage>): DbIndexUsage {
  return {
    schemaName: "public",
    tableName: "users",
    indexName: "idx",
    idxScan: 0,
    tableSeqScan: 0,
    approxRowCount: 0,
    ...p,
  };
}

function col(p: Partial<DbColumn>): DbColumn {
  return {
    schemaName: "public",
    tableName: "users",
    columnName: "x",
    dataType: "text",
    udtName: "text",
    isNullable: false,
    characterMaximumLength: null,
    ...p,
  };
}

function opts() {
  return { severity: "info" as const, config: {} };
}

function makeRegistry(spec: Record<string, Record<string, { type: string; isOptional?: boolean }>>): PrismaModelRegistry {
  const models = new Map();
  for (const [modelName, fields] of Object.entries(spec)) {
    models.set(modelName, {
      name: modelName,
      fields: Object.entries(fields).map(([fname, info]) => ({
        name: fname,
        type: info.type,
        isArray: false,
        isOptional: info.isOptional ?? false,
        attributes: [],
      })),
    });
  }
  return { models, enums: new Map() };
}
