/**
 * Heuristic matching of Zod schema names to Prisma model names.
 *
 * Strips conventional naming affixes ("Schema", "Dto", "Input", "Create",
 * "Update", "Patch", "Find", "Where") and then case-insensitive compares the
 * remainder against the model registry.
 *
 * Returns every Zod schema with a confident match. Schemas that don't match
 * any model are dropped — those are typically request/response wrappers
 * (pagination envelopes, error shapes, etc.) and not in scope for R01.
 */

import type { PrismaModelRegistry } from "../schema/prisma-models.js";
import type { ZodSchemaInfo } from "./discover.js";

export interface SchemaMatch {
  zod: ZodSchemaInfo;
  modelName: string;
}

const STRIP_AFFIXES = [
  "Schema",
  "Dto",
  "Input",
  "Output",
  "Response",
  "Request",
  "Create",
  "Update",
  "Patch",
  "Find",
  "Where",
  "Get",
  "Add",
  "List",
];

export function matchSchemasToModels(
  schemas: ZodSchemaInfo[],
  registry: PrismaModelRegistry,
): SchemaMatch[] {
  const lowerToModel = new Map<string, string>();
  for (const modelName of registry.models.keys()) {
    lowerToModel.set(modelName.toLowerCase(), modelName);
  }

  const matches: SchemaMatch[] = [];
  for (const zod of schemas) {
    if (zod.shape.kind !== "object") continue;
    const candidate = stripAffixes(zod.name).toLowerCase();
    if (!candidate) continue;
    const modelName = lowerToModel.get(candidate);
    if (!modelName) continue;
    matches.push({ zod, modelName });
  }
  return matches;
}

function stripAffixes(name: string): string {
  let core = name;
  let changed = true;
  while (changed) {
    changed = false;
    for (const affix of STRIP_AFFIXES) {
      // Strip trailing affix (case-sensitive, since these are conventional PascalCase tags).
      if (core.length > affix.length && core.endsWith(affix)) {
        core = core.slice(0, -affix.length);
        changed = true;
      }
      // Strip leading affix from camelCase names: "createUserInput" → "User".
      const leadingLower = affix.charAt(0).toLowerCase() + affix.slice(1);
      if (core.length > leadingLower.length && core.startsWith(leadingLower)) {
        core = core.slice(leadingLower.length);
        // Re-uppercase the new first char to preserve PascalCase comparison.
        core = core.charAt(0).toUpperCase() + core.slice(1);
        changed = true;
      }
    }
  }
  return core;
}
