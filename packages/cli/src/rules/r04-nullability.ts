/**
 * R04 — Nullability mismatch between Prisma and Zod.
 *
 * For every Zod object schema matched to a Prisma model, walk fields that
 * appear on both sides and compare nullability semantics:
 *
 *   - Prisma optional (`String?`) + Zod has none of .nullable() / .optional() /
 *     .nullish() / .default(...) → Zod is stricter than the DB. Reads from
 *     the DB will fail to parse when the column is null.
 *
 *   - Prisma required (`String`) + Zod is .nullable() (or .nullish()) → API
 *     accepts `null` but Prisma rejects it on insert/update → 500 at DB time.
 *
 * Cases intentionally NOT flagged:
 *
 *   - Prisma required + Zod .optional() (without .nullable()) — common in
 *     PATCH/Update inputs, semantically valid.
 *   - Prisma required + Zod .default(value) — the default fills in for the
 *     missing input, also semantically valid.
 *   - Array fields (Prisma `String[]`) — different shape, handled separately.
 *
 * See: packages/checks/rules/R04-nullability-mismatch.md
 */

import {
  loadPrismaRegistry,
  type FieldInfo,
  type PrismaModelRegistry,
} from "../schema/prisma-models.js";
import {
  discoverZodSchemas,
  type ZodChainCall,
  type ZodField,
  type ZodSchemaInfo,
} from "../zod/discover.js";
import { matchSchemasToModels } from "../zod/match.js";
import type { Finding, ProjectContext, Rule, RuleOptions } from "../types.js";

interface R04Config {
  ignoreModels?: string[];
  /** Skip schemas whose name ends with one of these (e.g. ["Update", "Patch"]). */
  ignoreSchemaSuffixes?: string[];
}

export const r04: Rule = {
  id: "R04",
  defaultSeverity: "error",

  async run(ctx: ProjectContext, options: RuleOptions): Promise<Finding[]> {
    const config = options.config as R04Config;
    const ignoreModels = new Set(config.ignoreModels ?? []);
    const ignoreSchemaSuffixes = config.ignoreSchemaSuffixes ?? [];

    const registry = await loadPrismaRegistry(ctx.schemaPath);
    const zodSchemas = await discoverZodSchemas(ctx.sourceFiles);
    const matches = matchSchemasToModels(zodSchemas, registry);

    const findings: Finding[] = [];
    for (const match of matches) {
      if (ignoreModels.has(match.modelName)) continue;
      if (hasIgnoredSuffix(match.zod.name, ignoreSchemaSuffixes)) continue;
      const model = registry.models.get(match.modelName);
      if (!model) continue;
      findings.push(...compareNullability(model.fields, match.zod, registry, options));
    }
    return findings;
  },
};

function compareNullability(
  fields: FieldInfo[],
  zod: ZodSchemaInfo,
  registry: PrismaModelRegistry,
  options: RuleOptions,
): Finding[] {
  if (zod.shape.kind !== "object") return [];

  const findings: Finding[] = [];
  const zodByName = new Map(zod.shape.fields.map((f) => [f.name, f]));

  for (const prismaField of fields) {
    if (prismaField.isArray) continue;
    if (isRelationField(prismaField, registry)) continue;

    const zodField = zodByName.get(prismaField.name);
    if (!zodField) continue;

    findings.push(...checkOneField(prismaField, zodField, zod, options));
  }

  return findings;
}

function checkOneField(
  prismaField: FieldInfo,
  zodField: ZodField,
  zod: ZodSchemaInfo,
  options: RuleOptions,
): Finding[] {
  const flags = readNullabilityFlags(zodField.chain);
  const acceptsNullOrUndefined = flags.nullable || flags.optional || flags.nullish;

  if (prismaField.isOptional) {
    if (acceptsNullOrUndefined || flags.hasDefault) return [];
    return [
      {
        ruleId: "R04",
        severity: options.severity,
        message: `Field \`${prismaField.name}\` is optional in Prisma (\`${prismaField.type}?\`) but \`${zod.name}\` requires a non-null, non-undefined value.`,
        location: { file: zod.file, line: zodField.line },
        suggestion: `Add \`.nullable()\` (for DB reads) or \`.optional()\` (for inputs that may omit the key) to \`${prismaField.name}\`.`,
        scope: { model: zod.name, field: prismaField.name },
      },
    ];
  }

  // Prisma required.
  if (flags.nullable || flags.nullish) {
    return [
      {
        ruleId: "R04",
        severity: options.severity,
        message: `Field \`${prismaField.name}\` is required in Prisma (\`${prismaField.type}\`) but \`${zod.name}\` accepts \`null\`.`,
        location: { file: zod.file, line: zodField.line },
        suggestion: `Remove \`.nullable()\`/\`.nullish()\` from \`${prismaField.name}\` — the DB will reject null on insert/update.`,
        scope: { model: zod.name, field: prismaField.name },
      },
    ];
  }

  return [];
}

interface NullabilityFlags {
  nullable: boolean;
  optional: boolean;
  nullish: boolean;
  hasDefault: boolean;
}

function readNullabilityFlags(chain: ZodChainCall[]): NullabilityFlags {
  const flags: NullabilityFlags = {
    nullable: false,
    optional: false,
    nullish: false,
    hasDefault: false,
  };
  for (const step of chain) {
    switch (step.name) {
      case "nullable":
        flags.nullable = true;
        break;
      case "optional":
        flags.optional = true;
        break;
      case "nullish":
        flags.nullish = true;
        break;
      case "default":
        flags.hasDefault = true;
        break;
    }
  }
  return flags;
}

function isRelationField(field: FieldInfo, registry: PrismaModelRegistry): boolean {
  if (registry.models.has(field.type)) return true;
  return field.attributes.some((attr) => attr.name === "relation");
}

function hasIgnoredSuffix(name: string, suffixes: string[]): boolean {
  return suffixes.some((s) => name.endsWith(s));
}
