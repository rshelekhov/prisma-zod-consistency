/**
 * R02 — `@relation` without explicit `onDelete`/`onUpdate`.
 *
 * Schema-only rule. Walks the Prisma AST, finds every field with a `@relation`
 * attribute, and flags ones that don't specify `onDelete:` (and, by default,
 * `onUpdate:`).
 *
 * See: packages/checks/rules/R02-onDelete-explicit.md
 */

import { getSchema } from "@mrleebo/prisma-ast";
import { mapCombinedLine } from "../schema/load-schema.js";
import type { Finding, ProjectContext, Rule, RuleOptions } from "../types.js";

interface R02Config {
  requireOnUpdate?: boolean;
  ignoreModels?: string[];
  ignoreRelations?: string[];
}

export const r02: Rule = {
  id: "R02",
  name: "@relation without explicit onDelete",
  description:
    "Flags Prisma @relation declarations that omit an explicit onDelete (and optionally onUpdate) action.",
  helpUri:
    "https://github.com/rshelekhov/prisma-zod-consistency/blob/main/packages/checks/rules/R02-onDelete-explicit.md",
  defaultSeverity: "warning",

  async run(ctx: ProjectContext, options: RuleOptions): Promise<Finding[]> {
    const config = options.config as R02Config;
    // Default: only require onDelete. onUpdate-on-relation is exotic
    // (most projects never mutate PKs), so requiring it produces noise on
    // codebases that are otherwise diligent about onDelete. Opt-in.
    const requireOnUpdate = config.requireOnUpdate ?? false;
    const ignoreModels = new Set(config.ignoreModels ?? []);
    const ignoreRelations = new Set(config.ignoreRelations ?? []);

    const source = ctx.schemaSource;
    const schema = getSchema(source);
    const sourceLines = source.split("\n");
    const modelLineRanges = computeModelLineRanges(sourceLines);

    const findings: Finding[] = [];

    for (const block of schema.list) {
      if (block.type !== "model") continue;
      const modelName = block.name;
      if (ignoreModels.has(modelName)) continue;

      for (const property of block.properties) {
        if (property.type !== "field") continue;
        const field = property;
        const relation = (field.attributes ?? []).find(
          (attr) => attr.type === "attribute" && attr.name === "relation",
        );
        if (!relation) continue;

        const fqRelation = `${modelName}.${field.name}`;
        if (ignoreRelations.has(fqRelation)) continue;

        const argKeys = collectKeyArgs(relation);
        // Only relations that own the FK have onDelete/onUpdate semantics —
        // identified by the presence of `fields:` on this side.
        if (!argKeys.has("fields")) continue;

        const missing: string[] = [];
        if (!argKeys.has("onDelete")) missing.push("onDelete");
        if (requireOnUpdate && !argKeys.has("onUpdate")) missing.push("onUpdate");
        if (missing.length === 0) continue;

        // prisma-ast does not attach source ranges to attribute nodes, so the
        // line lookup falls back to a token scan: find the field declaration
        // inside the model's line range. If anything goes wrong the rule still
        // returns line 1 — useful as a stable scope anchor.
        const range = modelLineRanges.get(modelName);
        const combinedLine =
          lineOf(relation) ??
          (range ? findFieldLine(sourceLines, range, field.name) : undefined) ??
          1;
        // Translate combined-source coordinates back to the original `.prisma`
        // file. For single-file projects this is a no-op; for multi-file
        // (Prisma 5.15+ `prismaSchemaFolder`) this maps the line into
        // bounty.prisma:5 instead of the synthetic combined position.
        const origin = mapCombinedLine(combinedLine, ctx.schemaSourceMap, ctx.schemaPath);

        findings.push({
          ruleId: "R02",
          severity: options.severity,
          message: `Relation ${fqRelation} is missing explicit ${missing.join(" and ")}.`,
          location: { file: origin.file, line: origin.line },
          suggestion: missing
            .map((k) => `Add \`${k}: <action>\` to the @relation arguments.`)
            .join(" "),
          scope: { model: modelName, field: field.name, relation: fqRelation },
        });
      }
    }

    return findings;
  },
};

/**
 * Walks the source line-by-line and computes 1-based [start, endExclusive]
 * line ranges for every `model X { ... }` block. `start` points at the line
 * with the `model X {` declaration, `endExclusive` at the line *after* the
 * closing `}`. Tolerates nested braces (e.g. inline arrays) by counting depth.
 */
function computeModelLineRanges(lines: string[]): Map<string, [number, number]> {
  const result = new Map<string, [number, number]>();
  let inModel: { name: string; start: number; depth: number } | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!inModel) {
      const m = line.match(/^\s*model\s+(\w+)\s*\{/);
      if (m?.[1]) {
        const opens = (line.match(/\{/g) ?? []).length;
        const closes = (line.match(/\}/g) ?? []).length;
        inModel = { name: m[1], start: i + 1, depth: opens - closes };
      }
      continue;
    }
    inModel.depth += (line.match(/\{/g) ?? []).length;
    inModel.depth -= (line.match(/\}/g) ?? []).length;
    if (inModel.depth <= 0) {
      result.set(inModel.name, [inModel.start, i + 2]);
      inModel = undefined;
    }
  }

  return result;
}

/**
 * Inside a model's line range, find the line where `fieldName` is declared.
 * Heuristic: the field declaration is the first line in the range that begins
 * (after whitespace) with the field name as a whole token. Returns 1-based
 * line number, or undefined if no match.
 */
function findFieldLine(
  lines: string[],
  range: [number, number],
  fieldName: string,
): number | undefined {
  const escaped = fieldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^\\s*${escaped}\\s+\\S`);
  const start = Math.max(range[0] - 1, 0);
  const end = Math.min(range[1] - 1, lines.length);
  for (let i = start; i < end; i++) {
    if (re.test(lines[i] ?? "")) return i + 1;
  }
  return undefined;
}

/**
 * Pulls the set of named keys from a `@relation(...)` attribute's arg list.
 * The prisma-ast shape for a relation arg looks like:
 *   { type: "attributeArgument", value: { type: "keyValue", key, value } }
 */
function collectKeyArgs(attribute: { args?: ReadonlyArray<unknown> }): Set<string> {
  const keys = new Set<string>();
  for (const arg of attribute.args ?? []) {
    if (!isObject(arg)) continue;
    const value = (arg as { value?: unknown }).value;
    if (!isObject(value)) continue;
    const v = value as { type?: unknown; key?: unknown };
    if (v.type === "keyValue" && typeof v.key === "string") {
      keys.add(v.key);
    }
  }
  return keys;
}

function lineOf(node: unknown): number | undefined {
  if (!isObject(node)) return undefined;
  const loc = (node as { location?: { startLine?: number } }).location;
  return typeof loc?.startLine === "number" ? loc.startLine : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
