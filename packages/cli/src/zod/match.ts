/**
 * Heuristic matching of Zod schema names to Prisma model names.
 *
 * Strips conventional naming affixes ("Schema", "Dto", "Input", "Create",
 * "Update", "Patch", "Find", "Where") and then case-insensitive compares the
 * remainder against the model registry.
 *
 * Optionally also strips a configurable set of single-character PascalCase
 * prefixes (default `["Z"]`) — recognising the `ZUser`/`TUser`/`IUser`
 * conventions popular in t3-stack, formbricks, and several Zod codegens.
 * The prefix is only stripped when the next character is uppercase, so
 * `Zone` is preserved while `ZUser` becomes `User`.
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

/** Default prefixes used when the caller doesn't pass `namingPrefixes`. */
const DEFAULT_NAMING_PREFIXES: readonly string[] = ["Z"];

export function matchSchemasToModels(
  schemas: ZodSchemaInfo[],
  registry: PrismaModelRegistry,
  namingPrefixes: readonly string[] = DEFAULT_NAMING_PREFIXES,
): SchemaMatch[] {
  const lowerToModel = new Map<string, string>();
  for (const modelName of registry.models.keys()) {
    lowerToModel.set(modelName.toLowerCase(), modelName);
  }

  const matches: SchemaMatch[] = [];
  for (const zod of schemas) {
    if (zod.shape.kind !== "object") continue;
    const candidate = stripAffixes(zod.name, namingPrefixes).toLowerCase();
    if (!candidate) continue;
    const modelName = lowerToModel.get(candidate);
    if (!modelName) continue;
    matches.push({ zod, modelName });
  }
  return matches;
}

/**
 * Public stripping helper — exported so other matchers (R03 enum-name
 * resolution, future per-rule lookups) can share the exact same convention
 * without duplicating the rules.
 *
 * Strip order, per while-iteration:
 *   1. Trailing PascalCase affix (`UserSchema` → `User`).
 *   2. Leading camelCase affix (`createUserInput` → `User`).
 *   3. Leading single-character prefix from `namingPrefixes`, gated on the
 *      next character being uppercase (`ZUser` → `User`, `Zone` → `Zone`).
 *
 * The loop runs until a pass makes no further changes, so chains like
 * `ZUserCreateInput` strip in stages: `Input` → `Create` → leading `Z`.
 */
export function stripAffixes(
  name: string,
  namingPrefixes: readonly string[] = DEFAULT_NAMING_PREFIXES,
): string {
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
    // Leading PascalCase prefix strip, gated on the next character being
    // uppercase. Only single-char prefixes are supported by design; longer
    // entries are tolerated but they only fire when the immediately
    // following character is uppercase, which is rarely useful past length 1.
    for (const prefix of namingPrefixes) {
      if (prefix.length === 0) continue;
      if (core.length <= prefix.length) continue;
      if (!core.startsWith(prefix)) continue;
      const nextChar = core.charAt(prefix.length);
      if (!isAsciiUppercase(nextChar)) continue;
      core = core.slice(prefix.length);
      changed = true;
    }
  }
  return core;
}

function isAsciiUppercase(ch: string): boolean {
  if (ch.length !== 1) return false;
  const code = ch.charCodeAt(0);
  return code >= 65 && code <= 90;
}
