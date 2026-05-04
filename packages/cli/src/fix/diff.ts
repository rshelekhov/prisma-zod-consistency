/**
 * Minimal unified-diff-ish formatter for dry-run preview of fixes.
 *
 * We don't ship a full diff library yet — the goal is just to give the user
 * enough context to see what each fix would change. Per file we print the
 * old line and the new line for every changed line.
 */

import { relative } from "node:path";
import pc from "picocolors";
import type { FileApplyReport } from "./apply.js";

export function formatDiff(reports: FileApplyReport[], cwd: string = process.cwd()): string {
  const lines: string[] = [];

  for (const report of reports) {
    if (report.applied === 0) continue;
    const filePath = relative(cwd, report.file);
    lines.push(pc.bold(`--- ${filePath}`));
    lines.push(pc.bold(`+++ ${filePath}`));
    lines.push(...lineDiff(report.oldContent, report.newContent));
    lines.push("");
  }

  return lines.join("\n");
}

function lineDiff(oldText: string, newText: string): string[] {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");

  // Naive line-by-line diff. Adequate for small focused fixes.
  // Real LCS-based diff would be a follow-up.
  const result: string[] = [];
  const maxLen = Math.max(oldLines.length, newLines.length);
  let inHunk = false;

  for (let i = 0; i < maxLen; i++) {
    const o = oldLines[i];
    const n = newLines[i];
    if (o === n) {
      if (inHunk) {
        result.push(pc.dim(`  ${o ?? ""}`));
        inHunk = false;
      }
      continue;
    }
    inHunk = true;
    if (o !== undefined) result.push(pc.red(`- ${o}`));
    if (n !== undefined) result.push(pc.green(`+ ${n}`));
  }

  return result;
}
