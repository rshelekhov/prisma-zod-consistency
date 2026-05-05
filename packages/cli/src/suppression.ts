/**
 * Suppression comments — let users silence individual findings without
 * disabling the rule globally. Mirrors the syntax popularised by ESLint /
 * Biome / prisma-lint so it's familiar.
 *
 * Supported syntax (TS / TSX files only — Prisma's comment syntax differs
 * and lives in a separate parser; see runner.ts):
 *
 *   // pz-disable-next-line                — silence every rule on the next line
 *   // pz-disable-next-line R03            — silence only R03 on the next line
 *   // pz-disable-next-line R03,R04        — silence R03 and R04 on the next line
 *   // pz-disable                          — silence every rule from here on
 *   // pz-disable R03                      — silence only R03 from here on
 *   // pz-enable                           — close every open block-disable
 *   // pz-enable R03                       — close R03's open block-disable
 *
 * A trailing reason in eslint style is permitted and ignored:
 *   // pz-disable-next-line R03 -- intentional widening for legacy import
 *
 * Lines and rule ids that don't match the regex are silently ignored.
 */

import { readFile } from "node:fs/promises";
import type { RuleId } from "./types.js";

type RulesSel = "*" | Set<RuleId>;

interface Block {
  /** 1-based, inclusive. */
  startLine: number;
  /** 1-based, inclusive. Set to file's last line if no matching `pz-enable`. */
  endLine: number;
  rules: RulesSel;
}

export interface SuppressionMap {
  isSuppressed(line: number, ruleId: RuleId): boolean;
}

const EMPTY_MAP: SuppressionMap = { isSuppressed: () => false };

/**
 * Build a suppression map from the source text of a single file. Pure
 * function — no IO. Used directly in tests; production code goes through
 * `getSuppressionMap` for caching.
 */
export function buildSuppressionMap(sourceText: string): SuppressionMap {
  const lines = sourceText.split(/\r?\n/);
  const blocks: Block[] = [];
  const nextLineDisables = new Map<number, RulesSel>();

  // For each "open" disable block we remember the line it started on.
  // Wildcard ("*") and per-rule blocks are tracked independently so a
  // rule-specific `pz-enable R03` doesn't accidentally close a wildcard.
  const openBlocks = new Map<"*" | RuleId, number>();

  const closeBlock = (key: "*" | RuleId, endLine: number): void => {
    const start = openBlocks.get(key);
    if (start === undefined) return;
    blocks.push({
      startLine: start,
      endLine,
      rules: key === "*" ? "*" : new Set<RuleId>([key]),
    });
    openBlocks.delete(key);
  };

  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + 1;
    const directive = parseDirective(lines[i]!);
    if (!directive) continue;

    if (directive.kind === "disable-next-line") {
      const target = lineNumber + 1;
      const merged = mergeRules(nextLineDisables.get(target), directive.rules);
      nextLineDisables.set(target, merged);
      continue;
    }

    if (directive.kind === "disable") {
      if (directive.rules === "*") {
        if (!openBlocks.has("*")) openBlocks.set("*", lineNumber);
      } else {
        for (const id of directive.rules) {
          if (!openBlocks.has(id)) openBlocks.set(id, lineNumber);
        }
      }
      continue;
    }

    // pz-enable
    if (directive.rules === "*") {
      for (const key of [...openBlocks.keys()]) closeBlock(key, lineNumber);
    } else {
      for (const id of directive.rules) closeBlock(id, lineNumber);
    }
  }

  // Anything still open at EOF runs to the last line.
  const eofLine = lines.length || 1;
  for (const key of [...openBlocks.keys()]) closeBlock(key, eofLine);

  return {
    isSuppressed(line, ruleId) {
      const next = nextLineDisables.get(line);
      if (next === "*") return true;
      if (next instanceof Set && next.has(ruleId)) return true;

      for (const block of blocks) {
        if (line < block.startLine || line > block.endLine) continue;
        if (block.rules === "*" || block.rules.has(ruleId)) return true;
      }
      return false;
    },
  };
}

interface Directive {
  kind: "disable-next-line" | "disable" | "enable";
  rules: RulesSel;
}

const DIRECTIVE_RE = /\/\/\s*pz-(disable-next-line|disable|enable)\b(.*)$/;
const RULE_ID_RE = /^R\d+$/;

function parseDirective(line: string): Directive | null {
  const m = DIRECTIVE_RE.exec(line);
  if (!m) return null;
  const kind = m[1] as Directive["kind"];
  const rest = m[2] ?? "";

  // Strip eslint-style trailing reason: "... R03 -- because X".
  const reasonIdx = rest.indexOf(" -- ");
  const argsPart = reasonIdx >= 0 ? rest.slice(0, reasonIdx) : rest;

  // Tokenize on commas + whitespace; keep only well-formed rule ids.
  const tokens = argsPart.split(/[,\s]+/).filter(Boolean);
  const ruleIds: RuleId[] = [];
  for (const t of tokens) {
    if (RULE_ID_RE.test(t)) ruleIds.push(t as RuleId);
    // Tokens that don't look like rule ids are ignored — keeps the parser
    // forgiving without doing anything weird with garbled directives.
  }

  if (ruleIds.length === 0) return { kind, rules: "*" };
  return { kind, rules: new Set(ruleIds) };
}

function mergeRules(existing: RulesSel | undefined, incoming: RulesSel): RulesSel {
  if (existing === undefined) return incoming;
  if (existing === "*" || incoming === "*") return "*";
  const merged = new Set<RuleId>(existing);
  for (const r of incoming) merged.add(r);
  return merged;
}

// ─── File-level cache ──────────────────────────────────────────────────

const cache = new Map<string, Promise<SuppressionMap>>();

/**
 * Read the file once and cache the resulting map for subsequent findings
 * pointing at the same path. The cache lifetime is the lifetime of the
 * Node process unless `clearSuppressionCache()` is called.
 */
export async function getSuppressionMap(filePath: string): Promise<SuppressionMap> {
  let p = cache.get(filePath);
  if (!p) {
    p = readFile(filePath, "utf-8")
      .then(buildSuppressionMap)
      .catch(() => EMPTY_MAP);
    cache.set(filePath, p);
  }
  return p;
}

/** Drop the file cache. Tests use this to keep cases isolated. */
export function clearSuppressionCache(): void {
  cache.clear();
}
