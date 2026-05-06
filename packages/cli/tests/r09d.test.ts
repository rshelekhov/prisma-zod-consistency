/**
 * R09d — default-value drift between Prisma `@default(...)` and live DB DEFAULT.
 *
 * Two layers of testing:
 *   1. `normalizeDbDefault` / `normalizePrismaDefault` / `defaultsEqual` —
 *      pure normalization unit tests, exercised against representative
 *      Postgres / MySQL / SQLite raw default expressions.
 *   2. `diffDefaults` — synthetic registry × DbColumn[] integration cases
 *      covering every finding class plus skip-list and ignore config.
 */

import { describe, expect, it } from "vitest";
import type { DbColumn } from "../src/db/types.js";
import { diffDefaults } from "../src/rules/r09d-default-values-drift.js";
import {
  defaultsEqual,
  normalizeDbDefault,
  normalizePrismaDefault,
} from "../src/schema/default-normalize.js";
import type { FieldInfo, PrismaModelRegistry } from "../src/schema/prisma-models.js";

describe("normalizeDbDefault — provider-side raw → normalized", () => {
  it("strips Postgres `::type` casts before parsing string literals", () => {
    expect(normalizeDbDefault("'draft'::text")).toEqual({ kind: "string", value: "draft" });
    expect(normalizeDbDefault("'pending'::character varying")).toEqual({
      kind: "string",
      value: "pending",
    });
  });

  it("strips Postgres casts on numbers", () => {
    expect(normalizeDbDefault("42::int4")).toEqual({ kind: "number", value: 42 });
  });

  it("normalizes the `now()` family across providers", () => {
    expect(normalizeDbDefault("now()")).toEqual({ kind: "now" });
    expect(normalizeDbDefault("CURRENT_TIMESTAMP")).toEqual({ kind: "now" });
    expect(normalizeDbDefault("current_timestamp(3)")).toEqual({ kind: "now" });
    expect(normalizeDbDefault("now()::timestamp")).toEqual({ kind: "now" });
  });

  it("returns 'skip' for nextval / gen_random_uuid / uuid_generate_v4", () => {
    expect(normalizeDbDefault("nextval('users_id_seq'::regclass)")).toEqual({ kind: "skip" });
    expect(normalizeDbDefault("gen_random_uuid()")).toEqual({ kind: "skip" });
    expect(normalizeDbDefault("uuid_generate_v4()")).toEqual({ kind: "skip" });
  });

  it("folds boolean spellings (true/false, 't'/'f', 'true'/'false')", () => {
    expect(normalizeDbDefault("true")).toEqual({ kind: "boolean", value: true });
    expect(normalizeDbDefault("'t'")).toEqual({ kind: "boolean", value: true });
    expect(normalizeDbDefault("'true'")).toEqual({ kind: "boolean", value: true });
    expect(normalizeDbDefault("false")).toEqual({ kind: "boolean", value: false });
    expect(normalizeDbDefault("'f'")).toEqual({ kind: "boolean", value: false });
  });

  it("parses signed and floating-point numbers numerically", () => {
    expect(normalizeDbDefault("42")).toEqual({ kind: "number", value: 42 });
    expect(normalizeDbDefault("42.0")).toEqual({ kind: "number", value: 42 }); // numeric equality
    expect(normalizeDbDefault("-1")).toEqual({ kind: "number", value: -1 });
  });

  it("returns 'absent' for null / empty", () => {
    expect(normalizeDbDefault(null)).toEqual({ kind: "absent" });
    expect(normalizeDbDefault("")).toEqual({ kind: "absent" });
  });

  it("falls back to 'raw' for unrecognised expressions", () => {
    expect(normalizeDbDefault("custom_func(arg1, arg2)")).toEqual({
      kind: "raw",
      value: "custom_func(arg1, arg2)",
    });
  });
});

describe("normalizePrismaDefault — Prisma side", () => {
  it("returns 'absent' when the field has no @default", () => {
    const f = field("status", "String", []);
    expect(normalizePrismaDefault(f)).toEqual({ kind: "absent" });
  });

  it("normalizes string / number / boolean literal defaults", () => {
    expect(
      normalizePrismaDefault(field("status", "String", [defaultAttr({ literal: "draft" })])),
    ).toEqual({ kind: "string", value: "draft" });
    expect(normalizePrismaDefault(field("count", "Int", [defaultAttr({ literal: 0 })]))).toEqual({
      kind: "number",
      value: 0,
    });
    expect(
      normalizePrismaDefault(field("active", "Boolean", [defaultAttr({ literal: true })])),
    ).toEqual({ kind: "boolean", value: true });
  });

  it("normalizes now() to the canonical clock token", () => {
    expect(
      normalizePrismaDefault(field("createdAt", "DateTime", [defaultAttr({ fn: "now" })])),
    ).toEqual({ kind: "now" });
  });

  it("returns 'skip' for cuid() / uuid() / autoincrement() / dbgenerated()", () => {
    expect(normalizePrismaDefault(field("id", "String", [defaultAttr({ fn: "cuid" })]))).toEqual({
      kind: "skip",
    });
    expect(normalizePrismaDefault(field("id", "String", [defaultAttr({ fn: "uuid" })]))).toEqual({
      kind: "skip",
    });
    expect(
      normalizePrismaDefault(field("id", "Int", [defaultAttr({ fn: "autoincrement" })])),
    ).toEqual({ kind: "skip" });
    expect(
      normalizePrismaDefault(field("id", "String", [defaultAttr({ fn: "dbgenerated" })])),
    ).toEqual({ kind: "skip" });
  });
});

describe("defaultsEqual — comparison verdict", () => {
  it("treats 'skip' on either side as equal (no false positives on autoincrement etc.)", () => {
    expect(defaultsEqual({ kind: "skip" }, { kind: "absent" })).toBe(true);
    expect(defaultsEqual({ kind: "absent" }, { kind: "skip" })).toBe(true);
    expect(defaultsEqual({ kind: "skip" }, { kind: "string", value: "x" })).toBe(true);
  });

  it("compares strings / numbers / booleans by value", () => {
    expect(
      defaultsEqual({ kind: "string", value: "draft" }, { kind: "string", value: "draft" }),
    ).toBe(true);
    expect(
      defaultsEqual({ kind: "string", value: "draft" }, { kind: "string", value: "pending" }),
    ).toBe(false);
    expect(defaultsEqual({ kind: "number", value: 42 }, { kind: "number", value: 42 })).toBe(true);
    expect(defaultsEqual({ kind: "number", value: 42 }, { kind: "number", value: 43 })).toBe(false);
  });

  it("returns true for now ↔ now even when the underlying expression text differs", () => {
    expect(defaultsEqual({ kind: "now" }, { kind: "now" })).toBe(true);
  });

  it("flags absent vs concrete as drift", () => {
    expect(defaultsEqual({ kind: "absent" }, { kind: "string", value: "draft" })).toBe(false);
    expect(defaultsEqual({ kind: "string", value: "draft" }, { kind: "absent" })).toBe(false);
  });
});

describe("R09d.diffDefaults — integration", () => {
  it("does not flag matched string defaults across Postgres cast normalization", () => {
    const registry = makeRegistry({
      Post: [field("status", "String", [defaultAttr({ literal: "draft" })])],
    });
    const dbColumns: DbColumn[] = [
      dbCol({ tableName: "Post", columnName: "status", columnDefault: "'draft'::text" }),
    ];
    expect(diffDefaults(registry, dbColumns, opts())).toEqual([]);
  });

  it("flags drift when Prisma says 'draft' and DB says 'pending'", () => {
    const registry = makeRegistry({
      Post: [field("status", "String", [defaultAttr({ literal: "draft" })])],
    });
    const dbColumns: DbColumn[] = [
      dbCol({ tableName: "Post", columnName: "status", columnDefault: "'pending'::text" }),
    ];
    const findings = diffDefaults(registry, dbColumns, opts());
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("drift");
    expect(findings[0]?.message).toContain("Post.status");
    expect(findings[0]?.message).toContain("'draft'");
    expect(findings[0]?.message).toContain("'pending'");
  });

  it("does not flag autoincrement Int → DB nextval (skip on both sides)", () => {
    const registry = makeRegistry({
      User: [field("id", "Int", [defaultAttr({ fn: "autoincrement" })])],
    });
    const dbColumns: DbColumn[] = [
      dbCol({
        tableName: "User",
        columnName: "id",
        columnDefault: "nextval('User_id_seq'::regclass)",
      }),
    ];
    expect(diffDefaults(registry, dbColumns, opts())).toEqual([]);
  });

  it("does not flag now() vs CURRENT_TIMESTAMP", () => {
    const registry = makeRegistry({
      Post: [field("createdAt", "DateTime", [defaultAttr({ fn: "now" })])],
    });
    const dbColumns: DbColumn[] = [
      dbCol({ tableName: "Post", columnName: "createdAt", columnDefault: "CURRENT_TIMESTAMP" }),
    ];
    expect(diffDefaults(registry, dbColumns, opts())).toEqual([]);
  });

  it("flags absent-on-Prisma vs DB-has-default", () => {
    const registry = makeRegistry({
      Post: [field("priority", "Int", [])],
    });
    const dbColumns: DbColumn[] = [
      dbCol({ tableName: "Post", columnName: "priority", columnDefault: "0" }),
    ];
    const findings = diffDefaults(registry, dbColumns, opts());
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("Post.priority");
    expect(findings[0]?.message).toContain("<no default>");
  });

  it("respects ignoreColumns regex", () => {
    const registry = makeRegistry({
      Post: [field("created_at", "DateTime", [defaultAttr({ fn: "now" })])],
    });
    const dbColumns: DbColumn[] = [
      // intentionally drifted to a non-now value
      dbCol({ tableName: "Post", columnName: "created_at", columnDefault: "'2024-01-01'::date" }),
    ];
    const findings = diffDefaults(registry, dbColumns, {
      severity: "warning",
      config: { ignoreColumns: ["^created_at$"] },
    });
    expect(findings).toEqual([]);
  });
});

// ---- helpers ----

function field(name: string, type: string, attributes: FieldInfo["attributes"]): FieldInfo {
  return {
    name,
    type,
    isArray: false,
    isOptional: false,
    attributes,
  };
}

function defaultAttr(p: {
  literal?: string | number | boolean;
  fn?: string;
}): FieldInfo["attributes"][number] {
  if (p.literal !== undefined) {
    return {
      name: "default",
      args: [{ kind: "literal", value: p.literal }],
    };
  }
  if (p.fn !== undefined) {
    return {
      name: "default",
      args: [{ kind: "function", name: p.fn }],
    };
  }
  return { name: "default", args: [] };
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
