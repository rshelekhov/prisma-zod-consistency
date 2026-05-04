/**
 * R01 — Zod ↔ Prisma field drift.
 *
 * Scope of this iteration: R01a only (hand-written Zod, no generator
 * detected). Within R01a, we cover:
 *   - Type compatibility (String ↔ z.string(), Int ↔ z.number().int(), etc.)
 *   - @db.VarChar(N) ↔ .max(N) numeric comparison
 *
 * Deferred to other rules / iterations:
 *   - Nullability (Prisma `?` ↔ .nullable()/.optional())   → R04
 *   - Enum field type drift                                → R03
 *   - R01b (generated only) and R01c (hybrid)              → next iteration
 *
 * See: packages/checks/rules/R01-zod-prisma-field-drift.md
 */

import { loadPrismaRegistry, type FieldInfo, type PrismaModelRegistry } from "../schema/prisma-models.js";
import { discoverZodSchemas, type ZodChainCall, type ZodField, type ZodSchemaInfo } from "../zod/discover.js";
import { matchSchemasToModels } from "../zod/match.js";
import type { Finding, ProjectContext, Rule, RuleOptions } from "../types.js";

interface R01Config {
  ignoreModels?: string[];
}

export const r01: Rule = {
  id: "R01",
  defaultSeverity: "error",

  async run(ctx: ProjectContext, options: RuleOptions): Promise<Finding[]> {
    if (ctx.zodMode.kind !== "hand-written") {
      // R01b and R01c land in a later iteration; no-op for now so the rule
      // doesn't false-positive on generated schemas.
      return [];
    }

    const config = options.config as R01Config;
    const ignoreModels = new Set(config.ignoreModels ?? []);

    const registry = await loadPrismaRegistry(ctx.schemaPath);
    const zodSchemas = await discoverZodSchemas(ctx.sourceFiles);
    const matches = matchSchemasToModels(zodSchemas, registry);

    const findings: Finding[] = [];
    for (const match of matches) {
      if (ignoreModels.has(match.modelName)) continue;
      const model = registry.models.get(match.modelName);
      if (!model) continue;
      findings.push(...compareModelToSchema(model.fields, match.zod, registry, options));
    }
    return findings;
  },
};

function compareModelToSchema(
  fields: FieldInfo[],
  zod: ZodSchemaInfo,
  registry: PrismaModelRegistry,
  options: RuleOptions,
): Finding[] {
  if (zod.shape.kind !== "object") return [];

  const findings: Finding[] = [];
  const zodByName = new Map(zod.shape.fields.map((f) => [f.name, f]));

  for (const prismaField of fields) {
    if (isRelationField(prismaField, registry)) continue;
    if (registry.enums.has(prismaField.type)) continue; // R03 territory
    const zodField = zodByName.get(prismaField.name);
    if (!zodField) continue; // schema may legitimately omit fields (DTO subset)

    findings.push(...checkTypeCompatibility(prismaField, zodField, zod, options));
    findings.push(...checkVarcharMax(prismaField, zodField, zod, options));
  }

  return findings;
}

function isRelationField(field: FieldInfo, registry: PrismaModelRegistry): boolean {
  if (registry.models.has(field.type)) return true;
  return field.attributes.some((attr) => attr.name === "relation");
}

function checkTypeCompatibility(
  prismaField: FieldInfo,
  zodField: ZodField,
  zod: ZodSchemaInfo,
  options: RuleOptions,
): Finding[] {
  // Prisma array fields (`String[]`, `Int[]`, etc.) must be `z.array(...)` on the Zod side.
  // We don't yet recurse into the array element type; that lands with R01 v2.
  if (prismaField.isArray) {
    if (zodField.baseType !== "array") {
      return [
        {
          ruleId: "R01",
          severity: options.severity,
          message: `Field \`${prismaField.name}\` is \`${prismaField.type}[]\` in Prisma but \`z.${zodField.baseType}()\` in \`${zod.name}\`.`,
          location: { file: zod.file, line: zodField.line },
          suggestion: `Use \`z.array(z.${expectedZodBaseTypes(prismaField.type)[0] ?? "unknown"}())\` to match the Prisma array type.`,
          scope: { model: matchedModelName(zod), field: prismaField.name },
        },
      ];
    }
    return [];
  }

  const expected = expectedZodBaseTypes(prismaField.type);
  if (expected.length === 0) return []; // unknown Prisma scalar — don't false-positive

  const actual = zodField.baseType;
  if (!expected.includes(actual)) {
    return [
      {
        ruleId: "R01",
        severity: options.severity,
        message: `Field \`${prismaField.name}\` is \`${prismaField.type}\` in Prisma but \`z.${actual}()\` in \`${zod.name}\`.`,
        location: { file: zod.file, line: zodField.line },
        suggestion: `Use ${expected.map((t) => `\`z.${t}()\``).join(" or ")} to match the Prisma type.`,
        scope: { model: matchedModelName(zod), field: prismaField.name },
      },
    ];
  }

  // Int requires .int() to reject non-integer numerics.
  if (prismaField.type === "Int" && !hasChainCall(zodField.chain, "int")) {
    return [
      {
        ruleId: "R01",
        severity: options.severity,
        message: `Field \`${prismaField.name}\` is \`Int\` in Prisma but the Zod schema in \`${zod.name}\` uses \`z.number()\` without \`.int()\`.`,
        location: { file: zod.file, line: zodField.line },
        suggestion: `Add \`.int()\` to the chain so non-integer numerics are rejected.`,
        fix: {
          description: `Append .int() to ${zod.name}.${prismaField.name}`,
          edits: [
            {
              file: zod.file,
              start: zodField.exprEnd,
              end: zodField.exprEnd,
              newText: ".int()",
            },
          ],
        },
        scope: { model: matchedModelName(zod), field: prismaField.name },
      },
    ];
  }

  return [];
}

function checkVarcharMax(
  prismaField: FieldInfo,
  zodField: ZodField,
  zod: ZodSchemaInfo,
  options: RuleOptions,
): Finding[] {
  const dbSize = prismaField.dbAttribute?.size;
  const dbKind = prismaField.dbAttribute?.kind;
  if (!dbSize || !isVarcharLike(dbKind)) return [];

  const zodMax = readMaxConstraint(zodField.chain);
  if (zodMax === undefined) {
    return [
      {
        ruleId: "R01",
        severity: options.severity,
        message: `Field \`${prismaField.name}\` is \`@db.${dbKind}(${dbSize})\` in Prisma; \`${zod.name}\` has no \`.max()\` to enforce that limit.`,
        location: { file: zod.file, line: zodField.line },
        suggestion: `Add \`.max(${dbSize})\` to \`${zodField.name}\`.`,
        fix: {
          description: `Append .max(${dbSize}) to ${zod.name}.${prismaField.name}`,
          edits: [
            {
              file: zod.file,
              start: zodField.exprEnd,
              end: zodField.exprEnd,
              newText: `.max(${dbSize})`,
            },
          ],
        },
        scope: { model: matchedModelName(zod), field: prismaField.name },
      },
    ];
  }

  if (zodMax > dbSize) {
    const maxArgRange = findMaxArgRange(zodField);
    const fixObj = maxArgRange
      ? {
          fix: {
            description: `Lower .max(${zodMax}) to .max(${dbSize}) on ${zod.name}.${prismaField.name}`,
            edits: [
              {
                file: zod.file,
                start: maxArgRange.start,
                end: maxArgRange.end,
                newText: String(dbSize),
              },
            ],
          },
        }
      : {};
    return [
      {
        ruleId: "R01",
        severity: options.severity,
        message: `Field \`${prismaField.name}\` allows \`.max(${zodMax})\` in Zod but the database is \`@db.${dbKind}(${dbSize})\`.`,
        location: { file: zod.file, line: zodField.line },
        suggestion: `Lower the Zod \`.max()\` to \`${dbSize}\` (or relax the Prisma column).`,
        ...fixObj,
        scope: { model: matchedModelName(zod), field: prismaField.name },
      },
    ];
  }

  return [];
}

function findMaxArgRange(zodField: ZodField): { start: number; end: number } | undefined {
  const max = zodField.chain.find((c) => c.name === "max");
  if (!max) return undefined;
  return max.argRanges?.[0];
}

function expectedZodBaseTypes(prismaType: string): string[] {
  switch (prismaType) {
    case "String":
      return ["string", "coerce.string"];
    case "Int":
    case "Float":
    case "Decimal":
      return ["number", "coerce.number"];
    case "BigInt":
      return ["bigint", "coerce.bigint"];
    case "Boolean":
      return ["boolean", "coerce.boolean"];
    case "DateTime":
      return ["date", "coerce.date"];
    case "Json":
      return ["any", "unknown", "record", "lazy"];
    default:
      return []; // Bytes and others — unsupported in this iteration
  }
}

function hasChainCall(chain: ZodChainCall[], name: string): boolean {
  return chain.some((c) => c.name === name);
}

function readMaxConstraint(chain: ZodChainCall[]): number | undefined {
  const max = chain.find((c) => c.name === "max");
  if (!max) return undefined;
  const arg = max.args[0];
  if (!arg) return undefined;
  const parsed = Number.parseInt(arg.trim(), 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function isVarcharLike(kind: string | undefined): boolean {
  if (!kind) return false;
  return kind === "VarChar" || kind === "Char" || kind === "NVarChar" || kind === "NChar";
}

function matchedModelName(zod: ZodSchemaInfo): string | undefined {
  // The schema name is the most useful scope hint we have without re-running the matcher.
  return zod.name;
}
