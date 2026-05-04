/**
 * Apply a list of file edits, grouping by file and replaying in
 * descending-position order so earlier edits don't shift later positions.
 *
 * Returns a summary report — files touched, edits applied, edits skipped
 * because they conflict with an earlier edit on the same range.
 */

import { readFile, writeFile } from "node:fs/promises";
import type { FileEdit, Finding } from "../types.js";

export interface ApplyOptions {
  /** When false, computes the new file contents but does not write them. */
  write: boolean;
}

export interface ApplyReport {
  files: FileApplyReport[];
  totalEditsApplied: number;
  totalEditsSkipped: number;
}

export interface FileApplyReport {
  file: string;
  oldContent: string;
  newContent: string;
  applied: number;
  skipped: number;
}

export async function applyFixes(
  findings: Finding[],
  options: ApplyOptions,
): Promise<ApplyReport> {
  const editsByFile = collectEdits(findings);
  const reports: FileApplyReport[] = [];
  let totalApplied = 0;
  let totalSkipped = 0;

  for (const [file, edits] of editsByFile) {
    const original = await readFile(file, "utf8");
    const { content, applied, skipped } = applyEditsToText(original, edits);
    if (options.write && applied > 0) {
      await writeFile(file, content, "utf8");
    }
    reports.push({
      file,
      oldContent: original,
      newContent: content,
      applied,
      skipped,
    });
    totalApplied += applied;
    totalSkipped += skipped;
  }

  return { files: reports, totalEditsApplied: totalApplied, totalEditsSkipped: totalSkipped };
}

function collectEdits(findings: Finding[]): Map<string, FileEdit[]> {
  const byFile = new Map<string, FileEdit[]>();
  for (const finding of findings) {
    if (!finding.fix) continue;
    for (const edit of finding.fix.edits) {
      const bucket = byFile.get(edit.file) ?? [];
      bucket.push(edit);
      byFile.set(edit.file, bucket);
    }
  }
  return byFile;
}

interface ApplyResult {
  content: string;
  applied: number;
  skipped: number;
}

function applyEditsToText(source: string, edits: FileEdit[]): ApplyResult {
  // Sort by start descending so applying an edit doesn't shift the offsets
  // of later edits. If two edits share a start, longer-range one first.
  const sorted = [...edits].sort((a, b) => {
    if (a.start !== b.start) return b.start - a.start;
    return b.end - a.end;
  });

  let content = source;
  let applied = 0;
  let skipped = 0;
  let lastAppliedStart = Infinity;

  for (const edit of sorted) {
    if (edit.end > lastAppliedStart) {
      // Overlaps with a previously applied edit — skip to keep determinism.
      skipped++;
      continue;
    }
    content = content.slice(0, edit.start) + edit.newText + content.slice(edit.end);
    applied++;
    lastAppliedStart = edit.start;
  }

  return { content, applied, skipped };
}
