import { relative } from "node:path";
import pc from "picocolors";
import type { Finding } from "../types.js";

export function formatPretty(findings: Finding[], cwd: string = process.cwd()): string {
  if (findings.length === 0) {
    return pc.green("✓ no findings");
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
