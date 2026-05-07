import { relative } from "node:path";
import pc from "picocolors";
import type { RunSummary } from "../runner.js";
import type { Finding } from "../types.js";

export function formatPretty(
  findings: Finding[],
  cwd: string = process.cwd(),
  summary?: RunSummary,
): string {
  if (findings.length === 0) {
    return formatZeroFindings(summary);
  }

  const byRule = groupBy(findings, (f) => f.ruleId);
  const lines: string[] = [];

  for (const [ruleId, group] of byRule) {
    lines.push("");
    lines.push(pc.bold(`[${ruleId}] (${group.length})`));
    for (const finding of group) {
      const file = relative(cwd, finding.location.file);
      const at = `${file}:${finding.location.line}`;
      lines.push(`  ${severityBadge(finding.severity)} ${at}`);
      lines.push(`    ${finding.message}`);
      if (finding.suggestion) {
        lines.push(pc.dim(`    → ${finding.suggestion}`));
      }
    }
  }

  const counts = countBySeverity(findings);
  lines.push("");
  lines.push(
    `${counts.error} error${plural(counts.error)}, ${counts.warning} warning${plural(
      counts.warning,
    )}, ${counts.info} info`,
  );

  return lines.join("\n");
}

/**
 * UX bug #5 (0.8.0): when the run produced no findings, the user previously
 * had no way to tell "tool found nothing" from "tool didn't actually look at
 * what I expected". The summary disambiguates.
 *
 * Nit #2 (0.9.0): extends the disambiguation with a separate branch for
 * `zodSchemaCount === 0` — typical first-run-on-monorepo failure where the
 * default `include = ["src/**\/*.ts"]` finds nothing because the project
 * keeps its TS sources under `apps/<app>/...` or `packages/<pkg>/...`.
 * Without this branch the run prints "✓ no findings (1 Prisma model, 0 Zod
 * schemas, 0 matched)" — green, with exit=0 — and the user thinks the
 * linter passed when really it didn't run anything.
 */
function formatZeroFindings(summary: RunSummary | undefined): string {
  if (!summary) {
    return pc.green("✓ no findings");
  }
  const { prismaModelCount, zodSchemaCount, matchedSchemaCount, namingPrefixes, includePaths } =
    summary;
  const detail =
    `${prismaModelCount} Prisma model${plural(prismaModelCount)}, ` +
    `${zodSchemaCount} Zod schema${plural(zodSchemaCount)}, ` +
    `${matchedSchemaCount} matched after name normalization`;

  if (zodSchemaCount === 0 && prismaModelCount > 0) {
    const includeShown =
      includePaths && includePaths.length > 0
        ? includePaths.map((p) => `"${p}"`).join(", ")
        : '(default: "src/**/*.ts","src/**/*.tsx")';
    return [
      pc.yellow(`⚠ no Zod schemas matched at include paths: [${includeShown}].`),
      pc.yellow(
        `  ${prismaModelCount} Prisma model${plural(prismaModelCount)} loaded, but no Zod schemas were scanned — R01/R03/R04 had nothing to compare.`,
      ),
      pc.dim("  If you are in a monorepo, extend `include` in .prismazodrc.json, e.g.:"),
      pc.dim('    "include": ["apps/**/*.ts","packages/**/*.ts"]'),
      pc.red("✗ 0 schemas matched (lint did not run)"),
    ].join("\n");
  }

  if (zodSchemaCount > 0 && matchedSchemaCount === 0) {
    const prefixesShown = namingPrefixes.length > 0 ? namingPrefixes.join('", "') : "(none)";
    return [
      pc.yellow(`⚠ no findings, but no Zod schemas matched any Prisma models (${detail}).`),
      pc.dim(
        `  Names are normalized by stripping affixes (Schema, Dto, Input, ...) and prefixes ["${prefixesShown}"].`,
      ),
      pc.dim(
        '  If your project uses a different naming convention, set `namingPrefixes` in `.prismazodrc.json` (e.g. ["T"] or ["I"], or [] to disable).',
      ),
    ].join("\n");
  }
  return `${pc.green("✓ no findings")} ${pc.dim(`(${detail})`)}`;
}

function severityBadge(severity: Finding["severity"]): string {
  switch (severity) {
    case "error":
      return pc.red("error");
    case "warning":
      return pc.yellow("warn");
    case "info":
      return pc.cyan("info");
  }
}

function plural(n: number): string {
  return n === 1 ? "" : "s";
}

function groupBy<T, K>(items: T[], keyFn: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const bucket = map.get(key);
    if (bucket) {
      bucket.push(item);
    } else {
      map.set(key, [item]);
    }
  }
  return map;
}

function countBySeverity(findings: Finding[]): Record<Finding["severity"], number> {
  const counts: Record<Finding["severity"], number> = { error: 0, warning: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;
  return counts;
}
