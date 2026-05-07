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

describe("Bug #9.A — Postgres cast strip with quoted/qualified type names", () => {
  it("strips a quoted user-defined enum cast", () => {
    expect(normalizeDbDefault("'user'::\"WebhookSource\"")).toEqual({
      kind: "string",
      value: "user",
    });
    expect(normalizeDbDefault("'pending'::\"SurveyStatus\"")).toEqual({
      kind: "string",
      value: "pending",
    });
  });

  it("strips schema-qualified casts (quoted both segments)", () => {
    expect(normalizeDbDefault('\'draft\'::"public"."SurveyStatus"')).toEqual({
      kind: "string",
      value: "draft",
    });
  });

  it("strips schema-qualified casts (bare schema, bare type)", () => {
    expect(normalizeDbDefault("'x'::pg_catalog.text")).toEqual({ kind: "string", value: "x" });
  });

  it("strips precision modifier on cast", () => {
    expect(normalizeDbDefault("now()::timestamp(3)")).toEqual({ kind: "now" });
    expect(normalizeDbDefault("'2024-01-01'::timestamp(6)")).toEqual({
      kind: "string",
      value: "2024-01-01",
    });
  });

  it("does not eat literal text inside single quotes that looks like a cast", () => {
    // `'foo::bar'` — a literal string whose content contains `::` but no
    // trailing cast suffix. Must round-trip unchanged.
    expect(normalizeDbDefault("'foo::bar'")).toEqual({ kind: "string", value: "foo::bar" });
  });
});

describe("Bug #9.B — Boolean string promotion (type-aware)", () => {
  it("promotes string literal 'false' on a Boolean field to boolean false", () => {
    // prisma-ast surfaces `@default(false)` as the string "false" (not the
    // boolean primitive). The normalizer must promote it on Boolean fields.
    const f = field("isUnique", "Boolean", [defaultAttr({ literal: "false" })]);
    expect(normalizePrismaDefault(f)).toEqual({ kind: "boolean", value: false });
  });

  it("promotes string literal 'true' on a Boolean field to boolean true", () => {
    const f = field("active", "Boolean", [defaultAttr({ literal: "true" })]);
    expect(normalizePrismaDefault(f)).toEqual({ kind: "boolean", value: true });
  });

  it("does NOT promote 'false' on a String field — keeps it as a literal string", () => {
    // Pathological but legal: `@default("false")` on a String column.
    // Must remain a string default — DB will report `'false'`, not `false`.
    const f = field("flag", "String", [defaultAttr({ literal: "false" })]);
    expect(normalizePrismaDefault(f)).toEqual({ kind: "string", value: "false" });
  });

  it("still accepts native boolean literal on a Boolean field (unchanged)", () => {
    // Belt-and-braces: if prisma-ast version changes and starts emitting a
    // real boolean primitive, behavior must stay correct.
    const f = field("active", "Boolean", [defaultAttr({ literal: true })]);
    expect(normalizePrismaDefault(f)).toEqual({ kind: "boolean", value: true });
  });

  it("R09d.diffDefaults: no finding for `@default(false)` vs DB `false`", () => {
    const registry = makeRegistry({
      ContactAttributeKey: [field("isUnique", "Boolean", [defaultAttr({ literal: "false" })])],
    });
    const dbColumns: DbColumn[] = [
      dbCol({
        tableName: "ContactAttributeKey",
        columnName: "isUnique",
        columnDefault: "false",
      }),
    ];
    expect(diffDefaults(registry, dbColumns, opts())).toEqual([]);
  });

  it("R09d.diffDefaults: real boolean drift still flagged (Prisma true vs DB false)", () => {
    const registry = makeRegistry({
      M: [field("flag", "Boolean", [defaultAttr({ literal: "true" })])],
    });
    const dbColumns: DbColumn[] = [
      dbCol({ tableName: "M", columnName: "flag", columnDefault: "false" }),
    ];
    const findings = diffDefaults(registry, dbColumns, opts());
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("M.flag");
  });
});

describe("Bug #9.C — JSON whitespace fold in defaultsEqual", () => {
  it("equates two JSON object strings that differ only in whitespace", () => {
    expect(
      defaultsEqual({ kind: "string", value: '{"a": 1}' }, { kind: "string", value: '{"a":1}' }),
    ).toBe(true);
    expect(
      defaultsEqual({ kind: "string", value: '{"a":1}' }, { kind: "string", value: '{ "a" : 1 }' }),
    ).toBe(true);
  });

  it("equates Prisma-escaped form against DB-unescaped form", () => {
    // Prisma `@default("{\"enabled\": false}")` yields `{\"enabled\": false}`
    // after stripQuotes (internal backslash-quote sequences preserved).
    // Postgres column_default reports `{"enabled": false}` after cast strip.
    expect(
      defaultsEqual(
        { kind: "string", value: '{\\"enabled\\": false}' },
        { kind: "string", value: '{"enabled": false}' },
      ),
    ).toBe(true);
  });

  it("does NOT equate JSON values with different content", () => {
    expect(
      defaultsEqual({ kind: "string", value: '{"a":1}' }, { kind: "string", value: '{"a":2}' }),
    ).toBe(false);
    expect(defaultsEqual({ kind: "string", value: "[]" }, { kind: "string", value: "[1,2]" })).toBe(
      false,
    );
  });

  it("does NOT JSON-fold plain string defaults (e.g. 'draft' vs 'pending')", () => {
    // Quick reject in tryParseJson: only `{` / `[` heads enter the JSON path,
    // so `'draft'` vs `'pending'` keeps raw string equality semantics.
    expect(
      defaultsEqual({ kind: "string", value: "draft" }, { kind: "string", value: "pending" }),
    ).toBe(false);
    expect(
      defaultsEqual({ kind: "string", value: "hello" }, { kind: "string", value: "hello" }),
    ).toBe(true);
  });

  it("equates [] (Prisma) with [] (DB) — both as strings", () => {
    expect(defaultsEqual({ kind: "string", value: "[]" }, { kind: "string", value: "[]" })).toBe(
      true,
    );
  });

  it("equates array-of-objects across whitespace differences", () => {
    expect(
      defaultsEqual(
        { kind: "string", value: '[{"a":1}]' },
        { kind: "string", value: '[{"a": 1}]' },
      ),
    ).toBe(true);
  });

  it("R09d.diffDefaults: no finding for Prisma '[]' vs DB '[]'::jsonb", () => {
    const registry = makeRegistry({
      Survey: [field("blocks", "Json", [defaultAttr({ literal: "[]" })])],
    });
    const dbColumns: DbColumn[] = [
      dbCol({
        tableName: "Survey",
        columnName: "blocks",
        columnDefault: "'[]'::jsonb",
      }),
    ];
    expect(diffDefaults(registry, dbColumns, opts())).toEqual([]);
  });

  it("R09d.diffDefaults: real JSON drift still flagged ([] vs [1,2])", () => {
    const registry = makeRegistry({
      Survey: [field("blocks", "Json", [defaultAttr({ literal: "[]" })])],
    });
    const dbColumns: DbColumn[] = [
      dbCol({
        tableName: "Survey",
        columnName: "blocks",
        columnDefault: "'[1,2]'::jsonb",
      }),
    ];
    const findings = diffDefaults(registry, dbColumns, opts());
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("Survey.blocks");
  });
});

describe("Bug #9.D — keyValue/array Prisma defaults serialize to JSON", () => {
  it("serializes an array-shaped default to a JSON string the comparer can fold", () => {
    // Synthesize the keyValue/array AttributeArg shapes prisma-ast can emit
    // for structural defaults — bypassing the test helper's literal path.
    const f: FieldInfo = {
      name: "blocks",
      type: "Json",
      isArray: false,
      isOptional: false,
      attributes: [
        {
          name: "default",
          args: [{ kind: "array", values: [] }],
        },
      ],
      columnName: "blocks",
    };
    expect(normalizePrismaDefault(f)).toEqual({ kind: "string", value: "[]" });
  });

  it("serializes a keyValue-shaped default to a JSON string", () => {
    const f: FieldInfo = {
      name: "data",
      type: "Json",
      isArray: false,
      isOptional: false,
      attributes: [
        {
          name: "default",
          args: [
            {
              kind: "keyValue",
              key: "enabled",
              value: { kind: "literal", value: false },
            },
          ],
        },
      ],
      columnName: "data",
    };
    // JSON.stringify({ enabled: false }) — comparer will JSON-fold this
    // against the DB side (`'{"enabled": false}'::jsonb` after cast strip).
    expect(normalizePrismaDefault(f)).toEqual({
      kind: "string",
      value: '{"enabled":false}',
    });
  });

  it("falls back to <keyValue> raw when the structure contains a function node", () => {
    const f: FieldInfo = {
      name: "data",
      type: "Json",
      isArray: false,
      isOptional: false,
      attributes: [
        {
          name: "default",
          args: [
            {
              kind: "keyValue",
              key: "k",
              value: { kind: "function", name: "now" },
            },
          ],
        },
      ],
      columnName: "data",
    };
    expect(normalizePrismaDefault(f)).toEqual({ kind: "raw", value: "<keyValue>" });
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
    columnName: extractMapColumn(attributes) ?? name,
  };
}

/**
 * Mirror the schema-loader's @map extraction so test fields constructed with a
 * `defaultAttr({...})` and a co-located `@map(...)` attribute report the right
 * `columnName`. Tests for bug #7 rely on this to assemble fixture fields with
 * mapped column names without re-implementing the parser.
 */
function extractMapColumn(attrs: FieldInfo["attributes"]): string | undefined {
  for (const attr of attrs) {
    if (attr.name !== "map") continue;
    for (const arg of attr.args) {
      if (arg.kind === "literal" && typeof arg.value === "string") return arg.value;
      if (arg.kind === "keyValue" && arg.key === "name") {
        const v = arg.value;
        if (v.kind === "literal" && typeof v.value === "string") return v.value;
      }
    }
  }
  return undefined;
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
