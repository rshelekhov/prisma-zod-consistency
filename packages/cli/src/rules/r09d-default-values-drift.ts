/**
 * R09d — Default-value drift between Prisma `@default(...)` and live DB DEFAULT.
 *
 * Companion to R09 (column existence + nullability), R09b (type drift), and
 * R09c (FK constraints drift). Compares the field-level default expression
 * Prisma declares against the raw `column_default` the database reports,
 * after running both sides through the normalizer in
 * `schema/default-normalize.ts`.
 *
 * Variant A + Variant C — the rule comfortably handles string / number /
 * boolean / `now()` defaults, and intentionally skips client-side or
 * generated defaults (`cuid()`, `uuid()`, `autoincrement()`,
 * `dbgenerated(...)`, `nextval(...)`).
 *
 * See: packages/checks/rules/R09d-default-values-drift.md
 */

import type { DbColumn } from "../db/types.js";
import {
  type NormalizedDefault,
  defaultsEqual,
  describeNormalized,
  normalizeDbDefault,
  normalizePrismaDefault,
} from "../schema/default-normalize.js";
import {
  type FieldInfo,
  type PrismaModelRegistry,
  loadPrismaRegistry,
} from "../schema/prisma-models.js";
import type { Finding, ProjectContext, Rule, RuleOptions } from "../types.js";

interface R09dConfig {
  ignoreTables?: string[];
  /** Skip columns matching any of these patterns on any table. */
  ignoreColumns?: string[];
}

export const r09d: Rule = {
  id: "R09d",
  name: "Default-value drift vs live DB",
  description:
    "Compares Prisma `@default(...)` declarations against the column DEFAULT reported by the database, with normalization for casts, quotes, numeric forms, and clock defaults.",
  helpUri:
    "https://github.com/rshelekhov/prisma-zod-consistency/blob/main/packages/checks/rules/R09d-default-values-drift.md",
  defaultSeverity: "warning",

  async run(ctx: ProjectContext, options: RuleOptions): Promise<Finding[]> {
    if (!ctx.db) return [];
    const registry = await loadPrismaRegistry(ctx.schemaPath);
    return diffDefaults(registry, ctx.db.columns, options);
  },
};

export function diffDefaults(
  registry: PrismaModelRegistry,
  dbColumns: DbColumn[],
  options: RuleOptions,
): Finding[] {
  const config = options.config as R09dConfig;
  const ignoreTables = new Set(config.ignoreTables ?? []);
  const ignoreColumns = (config.ignoreColumns ?? []).map((p) => new RegExp(p));

  const dbByTable = new Map<string, Map<string, DbColumn>>();
  for (const col of dbColumns) {
    let bucket = dbByTable.get(col.tableName);
    if (!bucket) {
      bucket = new Map();
      dbByTable.set(col.tableName, bucket);
    }
    bucket.set(col.columnName, col);
  }

  const findings: Finding[] = [];

  for (const model of registry.models.values()) {
    const tableName = model.tableName;
    if (ignoreTables.has(tableName)) continue;

    const colsForTable = dbByTable.get(tableName);
    if (!colsForTable) continue; // R09 covers missing tables

    for (const field of model.fields) {
      if (isRelationField(field, registry)) continue;
      const colName = resolveColumnName(field);
      if (ignoreColumns.some((re) => re.test(colName))) continue;

      const dbCol = colsForTable.get(colName);
      if (!dbCol) continue; // R09 covers missing columns

      const prismaSide: NormalizedDefault = normalizePrismaDefault(field);
      const dbSide: NormalizedDefault = normalizeDbDefault(dbCol.columnDefault);

      if (defaultsEqual(prismaSide, dbSide)) continue;

      findings.push({
        ruleId: "R09d",
        severity: options.severity,
        message: `Default-value drift on \`${model.name}.${field.name}\`: Prisma says ${describeNormalized(prismaSide)}, DB says ${describeNormalized(dbSide)}.`,
        location: { file: "<live-db>", line: 1 },
        suggestion:
          "Update `@default(...)` to match the DB, or write a migration that sets the column DEFAULT to match Prisma.",
        scope: { model: model.name, field: field.name },
      });
    }
  }

  return findings;
}

function resolveColumnName(field: FieldInfo): string {
  for (const attr of field.attributes) {
    if (attr.name === "map" && attr.args[0]) {
      const arg = attr.args[0];
      if (arg.kind === "literal" && typeof arg.value === "string") return arg.value;
    }
  }
  return field.name;
}

function isRelationField(field: FieldInfo, registry: PrismaModelRegistry): boolean {
  if (registry.models.has(field.type)) return true;
  return field.attributes.some((attr) => attr.name === "relation");
}
