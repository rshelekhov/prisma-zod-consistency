/**
 * R02 — `@relation` without explicit `onDelete`/`onUpdate`.
 *
 * Schema-only rule. Walks the Prisma AST, finds every field with a `@relation`
 * attribute, and flags ones that don't specify `onDelete:` (and, by default,
 * `onUpdate:`).
 *
 * See: packages/checks/rules/R02-onDelete-explicit.md
 */

import { readFile } from "node:fs/promises";
import { getSchema } from "@mrleebo/prisma-ast";
import type { Finding, ProjectContext, Rule, RuleOptions } from "../types.js";

interface R02Config {
  requireOnUpdate?: boolean;
  ignoreModels?: string[];
  ignoreRelations?: string[];
}

export const r02: Rule = {
  id: "R02",
  defaultSeverity: "warning",

  async run(ctx: ProjectContext, options: RuleOptions): Promise<Finding[]> {
    const config = options.config as R02Config;
    const requireOnUpdate = config.requireOnUpdate ?? true;
    const ignoreModels = new Set(config.ignoreModels ?? []);
    const ignoreRelations = new Set(config.ignoreRelations ?? []);

    const source = await readFile(ctx.schemaPath, "utf8");
    const schema = getSchema(source);

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

        findings.push({
          ruleId: "R02",
          severity: options.severity,
          message: `Relation ${fqRelation} is missing explicit ${missing.join(" and ")}.`,
          location: {
            file: ctx.schemaPath,
            line: lineOf(relation) ?? 1,
          },
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
