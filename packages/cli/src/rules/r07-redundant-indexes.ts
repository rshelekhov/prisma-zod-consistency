/**
 * R07 — Redundant indexes.
 *
 * Detects pairs of indexes on the same table where one's leading column list
 * is a strict prefix of another's. The narrower index is redundant — Postgres
 * uses the wider one for any query that the narrower one would have served.
 *
 * Excludes:
 *   - Primary keys (covered=PK and covered_by=other regular index is fine)
 *   - Partial indexes (different filter -> different scope, not redundant)
 *   - Unique indexes when the covering one isn't unique (uniqueness is a
 *     constraint, not just an access path)
 *
 * See: packages/checks/rules/R07-redundant-indexes.md
 */

import type { DbIndex } from "../db/types.js";
import type { Finding, ProjectContext, Rule, RuleOptions } from "../types.js";

export const r07: Rule = {
  id: "R07",
  name: "Redundant indexes",
  description:
    "Reports indexes whose leading column list is a strict prefix of another index on the same table (Postgres only).",
  helpUri:
    "https://github.com/rshelekhov/prisma-zod-consistency/blob/main/packages/checks/rules/R07-redundant-indexes.md",
  defaultSeverity: "info",

  async run(ctx: ProjectContext, options: RuleOptions): Promise<Finding[]> {
    if (!ctx.db) return []; // requires --db
    return findRedundancies(ctx.db.indexes, options);
  },
};

export function findRedundancies(indexes: DbIndex[], options: RuleOptions): Finding[] {
  const findings: Finding[] = [];
  const byTable = groupBy(indexes, (i) => i.tableName);

  for (const [tableName, group] of byTable) {
    for (const narrow of group) {
      if (narrow.isPartial) continue;
      if (narrow.isPrimary) continue;
      for (const wide of group) {
        if (wide === narrow) continue;
        if (wide.isPartial) continue;
        if (!isStrictPrefix(narrow.columns, wide.columns)) continue;
        // If the narrow index is unique but the wide one isn't, it's a
        // real constraint we can't drop without losing uniqueness.
        if (narrow.isUnique && !wide.isUnique) continue;

        findings.push({
          ruleId: "R07",
          severity: options.severity,
          message: `Index \`${narrow.indexName}\` on \`${tableName}(${narrow.columns.join(", ")})\` is redundant — fully covered by \`${wide.indexName}\` on \`(${wide.columns.join(", ")})\`.`,
          location: { file: "<live-db>", line: 1 },
          suggestion: `Drop \`${narrow.indexName}\` to reclaim write overhead. Verify nothing relies on its name in raw SQL first.`,
          scope: { model: tableName },
        });
      }
    }
  }
  return findings;
}

function isStrictPrefix(narrow: string[], wide: string[]): boolean {
  if (narrow.length === 0) return false;
  if (narrow.length >= wide.length) return false;
  for (let i = 0; i < narrow.length; i++) {
    if (narrow[i] !== wide[i]) return false;
  }
  return true;
}

function groupBy<T, K>(items: T[], key: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const bucket = map.get(k);
    if (bucket) bucket.push(item);
    else map.set(k, [item]);
  }
  return map;
}
