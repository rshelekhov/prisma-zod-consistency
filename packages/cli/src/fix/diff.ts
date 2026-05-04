/**
 * Unified-diff formatter for the dry-run preview of fixes.
 *
 * Built on top of the `diff` npm package (Myers algorithm), so unchanged
 * surrounding context renders as plain lines and only real edits show up
 * with `+` / `-` markers. The previous naive line-by-line implementation
 * couldn't tell unchanged-but-shifted lines apart from real edits and
 * produced confusing output on multi-block fixes.
 */

import { relative } from "node:path";
import { createTwoFilesPatch } from "diff";
import pc from "picocolors";
import type { FileApplyReport } from "./apply.js";

export function formatDiff(reports: FileApplyReport[], cwd: string = process.cwd()): string {
  const out: string[] = [];

  for (const report of reports) {
    if (report.applied === 0) continue;
    if (report.oldContent === report.newContent) continue;

    const filePath = relative(cwd, report.file);
    // `diff` writes its own --- / +++ headers; keep three lines of context
    // so the user can locate edits in surrounding code without dumping the
    // whole file.
    const patch = createTwoFilesPatch(
      filePath,
      filePath,
      report.oldContent,
      report.newContent,
      undefined,
      undefined,
      { context: 3 },
    );

    out.push(colorizePatch(patch));
  }

  return out.join("\n");
}

/**
 * Colorize a unified-diff patch:
 *   - `--- ...` / `+++ ...`  → bold
 *   - `@@ ... @@`            → cyan (hunk header)
 *   - `-...`                 → red    (removed line)
 *   - `+...`                 → green  (added line)
 *   - context lines          → dim    (surrounding unchanged source)
 *
 * The leading `Index:` and `===` lines that `createTwoFilesPatch` emits are
 * stripped — we already have headers from the patch itself.
 */
function colorizePatch(patch: string): string {
  const lines = patch.split("\n");
  const out: string[] = [];

  for (const line of lines) {
    if (line.startsWith("Index: ") || /^=+$/.test(line)) continue;
    if (line.startsWith("---") || line.startsWith("+++")) {
      out.push(pc.bold(line));
      continue;
    }
    if (line.startsWith("@@")) {
      out.push(pc.cyan(line));
      continue;
    }
    if (line.startsWith("-")) {
      out.push(pc.red(line));
      continue;
    }
    if (line.startsWith("+")) {
      out.push(pc.green(line));
      continue;
    }
    out.push(pc.dim(line));
  }

  return out.join("\n");
}
