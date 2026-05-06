/**
 * Multi-file Prisma schema loader (Bug #1, 0.8.0).
 *
 * Background: Prisma 5.15+ ships the `prismaSchemaFolder` preview feature, and
 * Prisma 6 makes it the default. Projects routinely split a single logical
 * schema across many `*.prisma` files (e.g. `packages/prisma/schema/link.prisma`,
 * `bounty.prisma`, ...). The CLI's original `discover()` only read the entry
 * file and missed the rest, so on dub (80 models, 36 files) we saw 3 models.
 *
 * Strategy:
 *   - `schemaPath` may now point at a single `.prisma` file OR at a directory
 *     containing `.prisma` files. Either way we collect every sibling file and
 *     concatenate them into one logical source.
 *   - The first file (the "entry") is appended verbatim. For every other file
 *     we strip top-level `datasource` and `generator` blocks, because the
 *     downstream Prisma AST parser rejects multiple `datasource` blocks and
 *     this matches Prisma's own multi-file rules: only the entry file owns
 *     them.
 *   - We track every line of the combined source back to its original file
 *     and original line number so R02 (and any future schema-anchored rule)
 *     can report findings against `bounty.prisma:5`, not the synthetic
 *     `combined.prisma:142`.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DiscoveryError } from "../discovery-error.js";

/** Per-line origin record. `schemaSourceMap[i]` describes combined-line `i+1`. */
export interface SourceLineOrigin {
  /** Absolute path to the original file the line came from. */
  file: string;
  /**
   * 1-based line number in the original file. May be `0` for synthetic
   * separator lines we insert between concatenated files (those map to no
   * real line; consumers should treat them as a no-op anchor).
   */
  line: number;
}

export interface LoadedSchema {
  /** Full, parser-ready Prisma source — single file or concatenated multi-file. */
  schemaSource: string;
  /** Per-line origin records — parallel to schemaSource lines. */
  schemaSourceMap: SourceLineOrigin[];
  /** Path to the entry file (the one the user pointed at, or first file in a directory). */
  primaryFile: string;
  /** Every `.prisma` file that contributed to the combined source. */
  files: string[];
  /** True when more than one file contributed. */
  multiFile: boolean;
}

/**
 * Load schema source for a path that may be a file or a directory.
 *
 * - File pointer + no siblings → single-file mode (cheap, identical to old
 *   behavior).
 * - File pointer + sibling `.prisma` files in the same directory → multi-file
 *   mode, with the file kept as the entry.
 * - Directory pointer → multi-file mode, sibling files sorted alphabetically.
 *
 * Throws `DiscoveryError` for: path doesn't exist, no `.prisma` files in a
 * directory pointer, or any I/O error reading a file.
 */
export async function loadSchemaSource(schemaPath: string): Promise<LoadedSchema> {
  const stats = await stat(schemaPath).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") {
      throw new DiscoveryError(`schema.prisma not found at ${schemaPath}`);
    }
    throw err;
  });

  let dir: string;
  let entryFile: string | undefined;
  if (stats.isDirectory()) {
    dir = schemaPath;
  } else {
    dir = dirname(schemaPath);
    entryFile = schemaPath;
  }

  const dirContents = await readdir(dir).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") {
      throw new DiscoveryError(`schema directory not found: ${dir}`);
    }
    throw err;
  });

  const prismaFiles = dirContents
    .filter((name) => name.endsWith(".prisma"))
    .map((name) => resolve(dir, name))
    .sort();

  if (prismaFiles.length === 0) {
    throw new DiscoveryError(`no .prisma files found in ${dir}`);
  }

  // If the user pointed at a specific file, ensure it's the entry. Otherwise
  // pick the alphabetically first file as entry — gives stable, predictable
  // ordering across runs.
  let orderedFiles: string[];
  if (entryFile) {
    orderedFiles = [entryFile, ...prismaFiles.filter((f) => f !== entryFile)];
  } else {
    orderedFiles = prismaFiles;
  }

  // Single-file fast path — no concat, no stripping, identical to pre-0.8 behavior.
  if (orderedFiles.length === 1) {
    const onlyFile = orderedFiles[0] ?? schemaPath;
    const source = await readFile(onlyFile, "utf8");
    const map = identitySourceMap(onlyFile, source);
    return {
      schemaSource: source,
      schemaSourceMap: map,
      primaryFile: onlyFile,
      files: orderedFiles,
      multiFile: false,
    };
  }

  // Multi-file: assemble line-by-line. Each entry in `combinedLines` matches
  // one entry in `combinedMap`, so the index arithmetic stays trivial:
  // combined-line N → combinedMap[N - 1]. No off-by-one drift from
  // string-concatenation tricks.
  const combinedLines: string[] = [];
  const combinedMap: SourceLineOrigin[] = [];

  for (let i = 0; i < orderedFiles.length; i++) {
    const file = orderedFiles[i];
    if (file === undefined) continue;
    const raw = await readFile(file, "utf8");

    let processedSource: string;
    let originalLineMap: number[];
    if (i === 0) {
      processedSource = raw;
      originalLineMap = sequentialLineMap(raw);
    } else {
      const stripped = stripTopLevelBlocks(raw, ["datasource", "generator"]);
      processedSource = stripped.text;
      originalLineMap = stripped.lineMap;
    }

    // Insert a blank-line separator so prisma-ast sees a clean break
    // between segments. The separator counts as a real combined line, with
    // a sentinel map entry (`line: 0`) anchored to the next file.
    if (combinedLines.length > 0) {
      combinedLines.push("");
      combinedMap.push({ file, line: 0 });
    }

    // Drop the final empty element that `split("\n")` produces for sources
    // ending in "\n". Leaving it in would emit a phantom blank line whose
    // map entry would silently shift everything that follows.
    const segmentLines = processedSource.split("\n");
    let effectiveLineMap = originalLineMap;
    if (segmentLines.length > 0 && segmentLines[segmentLines.length - 1] === "") {
      segmentLines.pop();
      if (effectiveLineMap.length > segmentLines.length) {
        effectiveLineMap = effectiveLineMap.slice(0, segmentLines.length);
      }
    }

    for (let j = 0; j < segmentLines.length; j++) {
      combinedLines.push(segmentLines[j] ?? "");
      combinedMap.push({ file, line: effectiveLineMap[j] ?? 0 });
    }
  }

  return {
    schemaSource: combinedLines.join("\n"),
    schemaSourceMap: combinedMap,
    primaryFile: orderedFiles[0] ?? schemaPath,
    files: orderedFiles,
    multiFile: true,
  };
}

/**
 * Build a 1-to-1 source map for a single source: combined line N ↔ original line N.
 */
function identitySourceMap(file: string, source: string): SourceLineOrigin[] {
  const lines = source.split("\n");
  return lines.map((_, idx) => ({ file, line: idx + 1 }));
}

/**
 * Returns an array where index `i` (0-based) holds the 1-based original line
 * number of the i-th line of `source`. Helpful for stripping below.
 */
function sequentialLineMap(source: string): number[] {
  const lines = source.split("\n");
  const map: number[] = new Array(lines.length);
  for (let i = 0; i < lines.length; i++) map[i] = i + 1;
  return map;
}

/**
 * Strip top-level `datasource` and `generator` blocks from a Prisma source,
 * tracking which original lines survived in the resulting text.
 *
 * "Top-level" here means a block whose opening brace is balanced by the very
 * next `}` at depth 1. We do not attempt to follow Prisma syntax in detail —
 * a brace counter is enough because the only nested constructs in a Prisma
 * datasource/generator block are field arrays, which never reach a depth
 * that would confuse a balanced-brace strip.
 *
 * Returns the stripped text plus a parallel array `lineMap` where
 * `lineMap[i] = original 1-based line number of the i-th surviving line`.
 */
export function stripTopLevelBlocks(
  source: string,
  blockTypes: string[],
): { text: string; lineMap: number[] } {
  const lines = source.split("\n");
  const survivingLines: string[] = [];
  const lineMap: number[] = [];

  const blockStartRe = new RegExp(`^\\s*(?:${blockTypes.join("|")})\\s+\\w+\\s*\\{`);

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (blockStartRe.test(line)) {
      // Count braces from this line on until depth returns to 0.
      let depth = 0;
      let j = i;
      while (j < lines.length) {
        const cur = lines[j] ?? "";
        for (const ch of cur) {
          if (ch === "{") depth += 1;
          else if (ch === "}") depth -= 1;
        }
        j += 1;
        if (depth <= 0) break;
      }
      // Skip lines [i, j). All consumed.
      i = j;
      continue;
    }
    survivingLines.push(line);
    lineMap.push(i + 1);
    i += 1;
  }

  return { text: survivingLines.join("\n"), lineMap };
}

/**
 * Translate a 1-based line number in the combined schema source to its
 * original (file, line) origin. Falls back to `(primaryFile, line)` for
 * out-of-range lookups.
 */
export function mapCombinedLine(
  combinedLine: number,
  schemaSourceMap: readonly SourceLineOrigin[],
  primaryFile: string,
): SourceLineOrigin {
  const idx = combinedLine - 1;
  if (idx < 0 || idx >= schemaSourceMap.length) {
    return { file: primaryFile, line: combinedLine };
  }
  const entry = schemaSourceMap[idx];
  if (!entry || entry.line === 0) {
    // Synthetic separator — anchor to the closest real line in the same file.
    for (let back = idx - 1; back >= 0; back -= 1) {
      const prev = schemaSourceMap[back];
      if (prev && prev.line > 0) return prev;
    }
    return { file: primaryFile, line: combinedLine };
  }
  return entry;
}
