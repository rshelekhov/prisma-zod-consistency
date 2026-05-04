/**
 * R09 — Schema drift vs live DB.
 *
 * Compares the parsed `schema.prisma` model registry against the actual
 * `information_schema.columns`. Catches cases that `prisma migrate diff`
 * misses — manual SQL migrations, columns added by other services to the
 * shared DB, columns left behind after a Prisma model removal.
 *
 * Three classes of drift:
 *   - Column in DB but not in Prisma model
 *   - Column in Prisma but not in DB
 *   - Column in both but nullability differs
 *
 * Type drift (varchar(100) vs varchar(255), etc.) is NOT in this rule —
 * that's R09b territory and lands in a follow-up.
 *
 * Note on table name resolution: Prisma's `@@map("table_name")` lets a
 * model use a different physical table. We do a best-effort match using
 * @@map first, then a snake_case conversion of the model name as fallback.
 *
 * See: packages/checks/rules/R09-schema-drift-vs-db.md
 */

import type { DbColumn } from "../db/types.js";
import {
  loadPrismaRegistry,
  type FieldInfo,
  type ModelInfo,
  type PrismaModelRegistry,
} from "../schema/prisma-models.js";
import type { Finding, ProjectContext, Rule, RuleOptions } from "../types.js";

interface R09Config {
  ignoreTables?: string[];
  /** Skip columns matching any of these patterns on any table. */
  ignoreColumns?: string[];
}

export const r09: Rule = {
  id: "R09",
  defaultSeverity: "warning",

  async run(ctx: ProjectContext, options: RuleOptions): Promise<Finding[]> {
    if (!ctx.db) return [];
    const registry = await loadPrismaRegistry(ctx.schemaPath);
    return diffPrismaVsDb(registry, ctx.db.columns, options);
  },
};

export function diffPrismaVsDb(
  registry: PrismaModelRegistry,
  dbColumns: DbColumn[],
  options: RuleOptions,
): Finding[] {
  const config = options.config as R09Config;
  const ignoreTables = new Set(config.ignoreTables ?? []);
  const ignoreColumns = (config.ignoreColumns ?? []).map((p) => new RegExp(p));

  const dbByTable = new Map<string, DbColumn[]>();
  for (const col of dbColumns) {
    const bucket = dbByTable.get(col.tableName) ?? [];
    bucket.push(col);
    dbByTable.set(col.tableName, bucket);
  }

  const findings: Finding[] = [];

  for (const model of registry.models.values()) {
    const tableName = resolveTableName(model);
    if (ignoreTables.has(tableName)) continue;

    const dbColsForTable = dbByTable.get(tableName);
    if (!dbColsForTable) {
      findings.push({
        ruleId: "R09",
        severity: options.severity,
        message: `Model \`${model.name}\` (table \`${tableName}\`) is declared in schema.prisma but does not exist in the database.`,
        location: { file: "<live-db>", line: 1 },
        suggestion: `Run pending migrations, or remove the model if it's been retired.`,
        scope: { model: model.name },
      });
      continue;
    }

    const dbByCol = new Map(dbColsForTable.map((c) => [c.columnName, c]));

    for (const field of model.fields) {
      if (isRelationField(field, registry)) continue;
      const dbColName = resolveColumnName(field);
      if (ignoreColumns.some((re) => re.test(dbColName))) continue;

      const dbCol = dbByCol.get(dbColName);
      if (!dbCol) {
        findings.push({
          ruleId: "R09",
          severity: options.severity,
          message: `Field \`${model.name}.${field.name}\` (column \`${dbColName}\`) is declared in schema.prisma but missing in the database.`,
          location: { file: "<live-db>", line: 1 },
          suggestion: `Run pending migrations.`,
          scope: { model: model.name, field: field.name },
        });
        continue;
      }

      // Nullability mismatch
      if (field.isOptional !== dbCol.isNullable) {
        const prismaSays = field.isOptional ? "optional" : "required";
        const dbSays = dbCol.isNullable ? "nullable" : "NOT NULL";
        findings.push({
          ruleId: "R09",
          severity: options.severity,
          message: `Nullability drift on \`${model.name}.${field.name}\`: Prisma says ${prismaSays}, DB says ${dbSays}.`,
          location: { file: "<live-db>", line: 1 },
          suggestion: `Reconcile via a migration or update schema.prisma to match the actual column.`,
          scope: { model: model.name, field: field.name },
        });
      }

      dbByCol.delete(dbColName);
    }

    // Anything left in dbByCol is a column the DB has but Prisma doesn't.
    for (const orphan of dbByCol.values()) {
      if (ignoreColumns.some((re) => re.test(orphan.columnName))) continue;
      findings.push({
        ruleId: "R09",
        severity: options.severity,
        message: `Column \`${orphan.tableName}.${orphan.columnName}\` exists in the database but is not declared in schema.prisma.`,
        location: { file: "<live-db>", line: 1 },
        suggestion: `Add the field to the model, or drop the orphan column if it's no longer used.`,
        scope: { model: model.name, field: orphan.columnName },
      });
    }
  }

  return findings;
}

function resolveTableName(model: ModelInfo): string {
  // Look for @@map("table_name") in any block-level attribute. Our current
  // PrismaModelRegistry doesn't expose block attributes yet, so fall back to
  // snake_case conversion of the model name. TODO: surface @@map.
  return toSnakeCase(model.name);
}

function resolveColumnName(field: FieldInfo): string {
  // @map("column_name") on the field maps to a different DB column name.
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

function toSnakeCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}
