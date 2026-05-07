/**
 * R09b — Type drift between Prisma `@db.*` and live DB column type.
 *
 * Companion to R09 (which handles existence + nullability). R09b focuses on
 * type-level mismatches:
 *   - `@db.VarChar(100)` in Prisma vs `varchar(255)` in DB
 *   - `Int` in Prisma vs `bigint` in DB
 *   - `text` ↔ `varchar` swaps
 *
 * Skips on SQLite via `DbCapabilities.typeDriftAccurate = false` — SQLite's
 * affinity-based typing makes most comparisons unreliable. The runner emits
 * a one-shot stderr warning when R09b is explicitly requested on SQLite, so
 * users understand why the rule produced nothing.
 *
 * See: packages/checks/rules/R09b-type-drift.md
 */

import type { DbColumn } from "../db/types.js";
import {
  type FieldInfo,
  type PrismaModelRegistry,
  parsePrismaRegistry,
} from "../schema/prisma-models.js";
import {
  type SupportedProvider,
  compareTypes,
  expectedColumnFor,
} from "../schema/prisma-type-map.js";
import type { Finding, ProjectContext, Rule, RuleOptions } from "../types.js";

interface R09bConfig {
  ignoreTables?: string[];
  /** Skip columns matching any of these patterns on any table. */
  ignoreColumns?: string[];
}

export const r09b: Rule = {
  id: "R09b",
  name: "Type drift vs live DB",
  description:
    "Compares the Prisma field type (with `@db.*` modifiers) against the actual column type reported by the database, flagging differences in type or length.",
  helpUri:
    "https://github.com/rshelekhov/prisma-zod-consistency/blob/main/packages/checks/rules/R09b-type-drift.md",
  defaultSeverity: "warning",

  async run(ctx: ProjectContext, options: RuleOptions): Promise<Finding[]> {
    if (!ctx.db) return [];
    // Provider can't deliver precise type info — silently skip. The runner
    // emits a single stderr warning when this happens so the user understands
    // why the rule produced nothing without flooding the findings stream.
    if (!ctx.db.capabilities.typeDriftAccurate) return [];
    if (!isSupportedProvider(ctx.provider)) return [];
    const registry = parsePrismaRegistry(ctx.schemaSource);
    return diffTypes(registry, ctx.db.columns, ctx.provider, options);
  },
};

export function diffTypes(
  registry: PrismaModelRegistry,
  dbColumns: DbColumn[],
  provider: SupportedProvider,
  options: RuleOptions,
): Finding[] {
  const config = options.config as R09bConfig;
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
    if (!colsForTable) continue; // existence-of-table is R09's job

    for (const field of model.fields) {
      if (isRelationField(field, registry)) continue;
      const colName = field.columnName;
      if (ignoreColumns.some((re) => re.test(colName))) continue;

      const dbCol = colsForTable.get(colName);
      if (!dbCol) continue; // missing-column is R09's job

      const expected = expectedColumnFor(field, provider);
      if (!expected) continue; // unknown scalar / not yet supported — skip silently

      const verdict = compareTypes(expected, dbCol);
      if (verdict !== "drift") continue;

      const prismaType = describePrismaType(field);
      const dbType = describeDbType(dbCol);
      findings.push({
        ruleId: "R09b",
        severity: options.severity,
        message: `Type drift on \`${model.name}.${field.name}\`: Prisma says ${prismaType}, DB says ${dbType}.`,
        location: { file: "<live-db>", line: 1 },
        suggestion:
          "Reconcile via a migration or update schema.prisma's `@db.*` modifier to match the actual column.",
        scope: { model: model.name, field: field.name },
      });
    }
  }

  return findings;
}

function describePrismaType(field: FieldInfo): string {
  if (field.dbAttribute) {
    const size = field.dbAttribute.size;
    return size !== undefined
      ? `${field.type} @db.${field.dbAttribute.kind}(${size})`
      : `${field.type} @db.${field.dbAttribute.kind}`;
  }
  return field.type;
}

function describeDbType(dbCol: DbColumn): string {
  // Prefer `udt_name` because that's the most-specific identifier across
  // Postgres + MySQL; fall back to `data_type` for providers/columns where
  // udt_name is empty. Append the length when present.
  const base = dbCol.udtName || dbCol.dataType;
  if (dbCol.characterMaximumLength !== null) {
    return `${base}(${dbCol.characterMaximumLength})`;
  }
  return base;
}

function isRelationField(field: FieldInfo, registry: PrismaModelRegistry): boolean {
  if (registry.models.has(field.type)) return true;
  return field.attributes.some((attr) => attr.name === "relation");
}

function isSupportedProvider(p: ProjectContext["provider"]): p is SupportedProvider {
  return p === "postgresql" || p === "mysql" || p === "sqlite";
}
