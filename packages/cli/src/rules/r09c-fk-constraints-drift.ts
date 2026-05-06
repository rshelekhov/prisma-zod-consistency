/**
 * R09c — Foreign-key constraint drift between Prisma `@relation` and live DB.
 *
 * Three classes of finding:
 *   - Missing FK in DB: Prisma declares an `@relation(fields:..., references:...)`
 *     but no matching constraint exists on the live database.
 *   - Extra FK in DB: a constraint exists in the database that Prisma's relation
 *     graph doesn't account for (orphan constraint left after a model was
 *     dropped, or a hand-rolled FK from another service).
 *   - Action drift: a matched FK whose `onDelete` / `onUpdate` differ between
 *     Prisma and the database.
 *
 * Matching is by `(tableName, sorted(columns))` — the same source columns on
 * the same physical table identify the same FK regardless of constraint name
 * (constraint names diverge wildly between Prisma migrations and hand-rolled
 * SQL — they're not load-bearing for matching).
 *
 * Skipped on every `excludeTables` table.
 *
 * See: packages/checks/rules/R09c-fk-constraints-drift.md
 */

import type { DbForeignKey } from "../db/types.js";
import { parsePrismaRegistry } from "../schema/prisma-models.js";
import { type ExpectedForeignKey, extractExpectedForeignKeys } from "../schema/prisma-relations.js";
import type { Finding, ProjectContext, Rule, RuleOptions } from "../types.js";

interface R09cConfig {
  ignoreTables?: string[];
  /** Skip relations matching these patterns. Each pattern is matched against `Model.field`. */
  ignoreRelations?: string[];
}

export const r09c: Rule = {
  id: "R09c",
  name: "Foreign-key constraints drift vs live DB",
  description:
    "Compares Prisma `@relation(...)` declarations against the foreign-key constraints reported by the database, flagging missing, extra, and action-drifted constraints.",
  helpUri:
    "https://github.com/rshelekhov/prisma-zod-consistency/blob/main/packages/checks/rules/R09c-fk-constraints-drift.md",
  defaultSeverity: "warning",

  async run(ctx: ProjectContext, options: RuleOptions): Promise<Finding[]> {
    if (!ctx.db) return [];
    const registry = parsePrismaRegistry(ctx.schemaSource);
    const expected = extractExpectedForeignKeys(registry);
    return diffForeignKeys(expected, ctx.db.foreignKeys, options);
  },
};

export function diffForeignKeys(
  expected: ExpectedForeignKey[],
  actual: DbForeignKey[],
  options: RuleOptions,
): Finding[] {
  const config = options.config as R09cConfig;
  const ignoreTables = new Set(config.ignoreTables ?? []);
  const ignoreRelations = (config.ignoreRelations ?? []).map((p) => new RegExp(p));

  const expectedFiltered = expected.filter(
    (e) =>
      !ignoreTables.has(e.tableName) &&
      !ignoreRelations.some((re) => re.test(`${e.modelName}.${e.relationFieldName}`)),
  );
  const actualFiltered = actual.filter((a) => !ignoreTables.has(a.tableName));

  const expectedByKey = new Map<string, ExpectedForeignKey>();
  for (const e of expectedFiltered) {
    expectedByKey.set(makeKey(e.tableName, e.columns), e);
  }
  const actualByKey = new Map<string, DbForeignKey>();
  for (const a of actualFiltered) {
    actualByKey.set(makeKey(a.tableName, a.columns), a);
  }

  const findings: Finding[] = [];

  // 1. Walk expected: every Prisma-declared FK should exist in DB.
  for (const [key, exp] of expectedByKey) {
    const act = actualByKey.get(key);
    if (!act) {
      findings.push({
        ruleId: "R09c",
        severity: options.severity,
        message: `Foreign key on \`${exp.modelName}.${exp.relationFieldName}\` (\`${exp.tableName}\`(${exp.columns.join(", ")}) → \`${exp.referencedTable}\`(${exp.referencedColumns.join(", ")})) is declared in schema.prisma but missing in the database.`,
        location: { file: "<live-db>", line: 1 },
        suggestion:
          "Run pending migrations, or drop the `@relation` if the constraint is intentionally absent.",
        scope: { model: exp.modelName, field: exp.relationFieldName, relation: exp.tableName },
      });
      continue;
    }
    // Matched on (table, columns). Now verify referenced shape and actions.
    const refTableMatches = exp.referencedTable === act.referencedTable;
    const refColsMatch =
      exp.referencedColumns.length === act.referencedColumns.length &&
      exp.referencedColumns.every((c, i) => c === act.referencedColumns[i]);
    if (!refTableMatches || !refColsMatch) {
      findings.push({
        ruleId: "R09c",
        severity: options.severity,
        message: `Foreign key on \`${exp.modelName}.${exp.relationFieldName}\` references \`${exp.referencedTable}\`(${exp.referencedColumns.join(", ")}) in schema.prisma but \`${act.referencedTable}\`(${act.referencedColumns.join(", ")}) in the database.`,
        location: { file: "<live-db>", line: 1 },
        suggestion: "Reconcile via a migration or update schema.prisma to match the live FK.",
        scope: { model: exp.modelName, field: exp.relationFieldName, relation: exp.tableName },
      });
      continue;
    }
    if (exp.onDelete !== act.onDelete || exp.onUpdate !== act.onUpdate) {
      findings.push({
        ruleId: "R09c",
        severity: options.severity,
        message: `Foreign-key action drift on \`${exp.modelName}.${exp.relationFieldName}\`: Prisma says onDelete=${exp.onDelete}, onUpdate=${exp.onUpdate}; DB says onDelete=${act.onDelete}, onUpdate=${act.onUpdate}.`,
        location: { file: "<live-db>", line: 1 },
        suggestion:
          "Update `@relation(... onDelete: ..., onUpdate: ...)` to match the DB, or write a migration to alter the constraint.",
        scope: { model: exp.modelName, field: exp.relationFieldName, relation: exp.tableName },
      });
    }
  }

  // 2. Walk actual: any FK in DB not in expected is an orphan.
  for (const [key, act] of actualByKey) {
    if (expectedByKey.has(key)) continue;
    findings.push({
      ruleId: "R09c",
      severity: options.severity,
      message: `Foreign key \`${act.constraintName}\` on \`${act.tableName}\`(${act.columns.join(", ")}) → \`${act.referencedTable}\`(${act.referencedColumns.join(", ")}) exists in the database but is not declared in schema.prisma.`,
      location: { file: "<live-db>", line: 1 },
      suggestion:
        "Add the missing `@relation` to schema.prisma if the constraint should stay, or drop it via migration.",
      scope: { model: act.tableName },
    });
  }

  return findings;
}

/**
 * Build a key for matching expected ↔ actual FKs.
 *
 * Uses `(table, sorted(columns))` so the same logical FK matches even when
 * Prisma's migration generator and a hand-rolled migration named the
 * constraint differently. Sort order is stable so we don't rely on
 * declaration order — `(orgId, userId)` and `(userId, orgId)` would still
 * key the same logical FK; the per-position comparison of
 * `referencedColumns` vs `columns` is done after matching.
 */
function makeKey(tableName: string, columns: string[]): string {
  return `${tableName}::${[...columns].sort().join(",")}`;
}
