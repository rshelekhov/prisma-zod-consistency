/**
 * R08 — Unused indexes.
 *
 * An index is "unused" if pg_stat_user_indexes reports `idx_scan = 0` over
 * the lifetime of the current stats window AND the parent table has done
 * meaningful work (some seq_scan + writes).
 *
 * Excludes:
 *   - Primary keys (always present, often look "unused" if the table is
 *     write-only).
 *   - Tiny tables (under `minRowCount`, default 1000) — Postgres
 *     legitimately picks a seq_scan over a small index.
 *
 * See: packages/checks/rules/R08-unused-indexes.md
 */

import type { DbIndex, DbIndexUsage } from "../db/types.js";
import type { Finding, ProjectContext, Rule, RuleOptions } from "../types.js";

interface R08Config {
  minRowCount?: number;
  /** Skip indexes whose name matches one of these (e.g. ["_pkey$"]). */
  ignoreIndexes?: string[];
}

export const r08: Rule = {
  id: "R08",
  name: "Unused indexes",
  description:
    "Reports indexes that pg_stat_user_indexes shows have never been scanned despite the parent table doing meaningful work.",
  helpUri:
    "https://github.com/rshelekhov/prisma-zod-consistency/blob/main/packages/checks/rules/R08-unused-indexes.md",
  defaultSeverity: "info",

  async run(ctx: ProjectContext, options: RuleOptions): Promise<Finding[]> {
    if (!ctx.db) return [];
    return findUnused(ctx.db.indexes, ctx.db.indexUsage, options);
  },
};

export function findUnused(
  indexes: DbIndex[],
  usage: DbIndexUsage[],
  options: RuleOptions,
): Finding[] {
  const config = options.config as R08Config;
  const minRowCount = config.minRowCount ?? 1000;
  const ignoreIndexes = (config.ignoreIndexes ?? []).map((p) => new RegExp(p));

  const indexByName = new Map(indexes.map((i) => [`${i.schemaName}.${i.indexName}`, i]));
  const findings: Finding[] = [];

  for (const u of usage) {
    if (u.idxScan > 0) continue;
    if (u.approxRowCount < minRowCount) continue;
    if (u.tableSeqScan === 0) continue; // table is dormant; can't conclude unused
    if (ignoreIndexes.some((re) => re.test(u.indexName))) continue;

    const idx = indexByName.get(`${u.schemaName}.${u.indexName}`);
    if (idx?.isPrimary) continue;

    findings.push({
      ruleId: "R08",
      severity: options.severity,
      message: `Index \`${u.indexName}\` on \`${u.tableName}\` has \`idx_scan = 0\` (table has ${u.tableSeqScan} seq scans, ~${u.approxRowCount.toLocaleString()} rows).`,
      location: { file: "<live-db>", line: 1 },
      suggestion: `Confirm the access pattern that this index was meant to serve still exists. If not, drop \`${u.indexName}\` to reclaim write overhead.`,
      scope: { model: u.tableName },
    });
  }
  return findings;
}
