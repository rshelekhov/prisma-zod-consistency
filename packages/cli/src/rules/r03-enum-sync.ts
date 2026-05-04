/**
 * R03 — Enum sync between Prisma and Zod.
 *
 * Two passes:
 *
 *   Pass 1 — top-level enum schemas
 *     For every `export const xSchema = z.enum([...])` or
 *     `z.nativeEnum(X)` in the project, find the matching Prisma enum
 *     by name heuristic and verify:
 *       - z.enum: literal values exactly match Prisma enum values (set comparison).
 *       - z.nativeEnum: the referenced identifier matches a Prisma enum name.
 *
 *   Pass 2 — enum-typed fields inside z.object schemas
 *     For every Zod object schema that matches a Prisma model, walk its
 *     fields. When the corresponding Prisma field's type is an enum:
 *       - If the Zod field is z.string()/z.number()/etc. → finding "use enum".
 *       - If z.enum: values must match.
 *       - If z.nativeEnum: identifier must match.
 *
 * See: packages/checks/rules/R03-enum-sync.md
 */

import { readFile } from "node:fs/promises";
import {
  loadPrismaRegistry,
  type PrismaModelRegistry,
} from "../schema/prisma-models.js";
import {
  discoverZodSchemas,
  type ZodField,
  type ZodSchemaInfo,
} from "../zod/discover.js";
import { matchSchemasToModels } from "../zod/match.js";
import type { Fix, Finding, ProjectContext, Rule, RuleOptions } from "../types.js";

interface R03Config {
  ignoreEnums?: string[];
  preferNativeEnum?: boolean;
}

export const r03: Rule = {
  id: "R03",
  defaultSeverity: "error",

  async run(ctx: ProjectContext, options: RuleOptions): Promise<Finding[]> {
    const config = options.config as R03Config;
    const ignoreEnums = new Set(config.ignoreEnums ?? []);
    const preferNativeEnum = config.preferNativeEnum ?? false;

    const registry = await loadPrismaRegistry(ctx.schemaPath);
    const zodSchemas = await discoverZodSchemas(ctx.sourceFiles);

    const findings: Finding[] = [];

    // Pass 1: top-level enum schemas.
    for (const schema of zodSchemas) {
      if (schema.shape.kind !== "enum") continue;
      const matchedEnum = matchEnumSchemaToPrisma(schema, registry);
      if (!matchedEnum) continue;
      if (ignoreEnums.has(matchedEnum)) continue;
      findings.push(...checkTopLevelEnumSchema(schema, matchedEnum, registry, options));
    }

    // Pass 2: enum-typed fields inside object schemas.
    const objectMatches = matchSchemasToModels(zodSchemas, registry);
    const sourceCache = new Map<string, string>();

    for (const match of objectMatches) {
      const model = registry.models.get(match.modelName);
      if (!model) continue;
      if (match.zod.shape.kind !== "object") continue;
      const zodByName = new Map(match.zod.shape.fields.map((f) => [f.name, f]));

      let source: string | undefined = sourceCache.get(match.zod.file);
      if (source === undefined) {
        source = await readFile(match.zod.file, "utf8");
        sourceCache.set(match.zod.file, source);
      }

      for (const prismaField of model.fields) {
        if (!registry.enums.has(prismaField.type)) continue;
        if (ignoreEnums.has(prismaField.type)) continue;
        const zodField = zodByName.get(prismaField.name);
        if (!zodField) continue;
        findings.push(
          ...checkFieldEnumDrift(
            zodField,
            prismaField.type,
            match.zod,
            source,
            options,
            preferNativeEnum,
            registry,
          ),
        );
      }
    }

    return findings;
  },
};

function matchEnumSchemaToPrisma(
  schema: ZodSchemaInfo,
  registry: PrismaModelRegistry,
): string | undefined {
  if (schema.shape.kind !== "enum") return undefined;
  // For nativeEnum the identifier itself is the most reliable signal.
  const ref = schema.shape.nativeEnumName;
  if (ref && registry.enums.has(ref)) return ref;

  // Otherwise fall back to the schema name with affixes stripped.
  const stripped = stripEnumAffixes(schema.name);
  if (!stripped) return undefined;
  const lowerToEnum = new Map<string, string>();
  for (const enumName of registry.enums.keys()) {
    lowerToEnum.set(enumName.toLowerCase(), enumName);
  }
  return lowerToEnum.get(stripped.toLowerCase());
}

function checkTopLevelEnumSchema(
  schema: ZodSchemaInfo,
  prismaEnumName: string,
  registry: PrismaModelRegistry,
  options: RuleOptions,
): Finding[] {
  if (schema.shape.kind !== "enum") return [];
  const prismaValues = registry.enums.get(prismaEnumName) ?? [];

  // nativeEnum: identifier match is sufficient.
  if (schema.shape.nativeEnumName) {
    if (schema.shape.nativeEnumName !== prismaEnumName) {
      return [
        {
          ruleId: "R03",
          severity: options.severity,
          message: `\`${schema.name}\` references \`${schema.shape.nativeEnumName}\` but matched Prisma enum \`${prismaEnumName}\`.`,
          location: { file: schema.file, line: schema.line },
          suggestion: `Use \`z.nativeEnum(${prismaEnumName})\` to bind the schema to the Prisma enum.`,
          scope: { model: schema.name },
        },
      ];
    }
    return [];
  }

  // z.enum literals: set comparison.
  return diffEnumValues(
    schema.name,
    schema.shape.values,
    prismaEnumName,
    prismaValues,
    schema.file,
    schema.line,
    options,
  );
}

function checkFieldEnumDrift(
  zodField: ZodField,
  prismaEnumName: string,
  schema: ZodSchemaInfo,
  source: string,
  options: RuleOptions,
  preferNativeEnum: boolean,
  registry: PrismaModelRegistry,
): Finding[] {
  const prismaValues = registry.enums.get(prismaEnumName) ?? [];
  if (zodField.baseType !== "enum" && zodField.baseType !== "nativeEnum") {
    return [
      {
        ruleId: "R03",
        severity: options.severity,
        message: `Field \`${zodField.name}\` is enum \`${prismaEnumName}\` in Prisma but \`z.${zodField.baseType}()\` in \`${schema.name}\`.`,
        location: { file: schema.file, line: zodField.line },
        suggestion: `Use \`z.nativeEnum(${prismaEnumName})\` to mirror the Prisma enum.`,
        scope: { model: schema.name, field: zodField.name },
        fix: buildBaseToNativeEnumFix(zodField, schema.file, prismaEnumName, source),
      },
    ];
  }

  if (zodField.baseType === "nativeEnum") {
    if (zodField.nativeEnumName && zodField.nativeEnumName !== prismaEnumName) {
      return [
        {
          ruleId: "R03",
          severity: options.severity,
          message: `Field \`${zodField.name}\` uses \`z.nativeEnum(${zodField.nativeEnumName})\` but Prisma type is \`${prismaEnumName}\`.`,
          location: { file: schema.file, line: zodField.line },
          suggestion: `Use \`z.nativeEnum(${prismaEnumName})\`.`,
          scope: { model: schema.name, field: zodField.name },
        },
      ];
    }
    return [];
  }

  // baseType === "enum": compare values.
  const findings = diffEnumValues(
    zodField.name,
    zodField.enumValues ?? [],
    prismaEnumName,
    prismaValues,
    schema.file,
    zodField.line,
    options,
  );

  if (preferNativeEnum && findings.length === 0) {
    findings.push({
      ruleId: "R03",
      severity: "info",
      message: `Field \`${zodField.name}\` uses \`z.enum([...])\` but \`z.nativeEnum(${prismaEnumName})\` would prevent future drift.`,
      location: { file: schema.file, line: zodField.line },
      suggestion: `Replace with \`z.nativeEnum(${prismaEnumName})\`.`,
      scope: { model: schema.name, field: zodField.name },
    });
  }

  return findings;
}

function diffEnumValues(
  zodName: string,
  zodValues: string[],
  prismaEnumName: string,
  prismaValues: string[],
  file: string,
  line: number,
  options: RuleOptions,
): Finding[] {
  const inPrisma = new Set(prismaValues);
  const inZod = new Set(zodValues);

  const missingFromZod: string[] = [];
  const extraInZod: string[] = [];

  for (const v of prismaValues) {
    if (!inZod.has(v)) missingFromZod.push(v);
  }
  for (const v of zodValues) {
    if (!inPrisma.has(v)) extraInZod.push(v);
  }

  if (missingFromZod.length === 0 && extraInZod.length === 0) return [];

  const parts: string[] = [];
  if (missingFromZod.length > 0) {
    parts.push(`missing in Zod: ${missingFromZod.join(", ")}`);
  }
  if (extraInZod.length > 0) {
    parts.push(`extra in Zod: ${extraInZod.join(", ")}`);
  }

  return [
    {
      ruleId: "R03",
      severity: options.severity,
      message: `Enum \`${zodName}\` does not match Prisma enum \`${prismaEnumName}\` — ${parts.join("; ")}.`,
      location: { file, line },
      suggestion: `Sync values: Prisma enum \`${prismaEnumName}\` is { ${prismaValues.join(", ")} }.`,
      scope: { model: zodName },
    },
  ];
}

/**
 * Build a fix that replaces a non-enum base call (e.g. `z.string()`) with
 * `z.nativeEnum(EnumName)`, optionally adding the import if it's not
 * already in scope.
 */
function buildBaseToNativeEnumFix(
  zodField: ZodField,
  file: string,
  prismaEnumName: string,
  source: string,
): Fix {
  const replaceBase = {
    file,
    start: zodField.exprStart,
    end: zodField.baseEnd,
    newText: `z.nativeEnum(${prismaEnumName})`,
  };

  const edits = [replaceBase];

  if (!enumIsInScope(source, prismaEnumName)) {
    edits.push({
      file,
      start: 0,
      end: 0,
      newText: `import { ${prismaEnumName} } from "@prisma/client";\n`,
    });
  }

  return {
    description: `Replace z.${zodField.baseType}() with z.nativeEnum(${prismaEnumName})`,
    edits,
  };
}

/**
 * Heuristic: is the symbol `name` already brought into scope by an import
 * statement in this file? Scans the first ~80 lines for any import that
 * names the symbol. Handles `import { X }`, `import { X as Y }`, and
 * `import { Y as X }` correctly enough for the common case.
 */
function enumIsInScope(source: string, name: string): boolean {
  const head = source.split("\n").slice(0, 80).join("\n");
  // Look for { ... name ... } in any import declaration.
  const importRegex = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["'][^"']+["']/g;
  let match: RegExpExecArray | null;
  while ((match = importRegex.exec(head)) !== null) {
    const namedImports = match[1] ?? "";
    const symbols = namedImports.split(",").map((s) => {
      // Handle "X as Y" — the local binding is Y.
      const parts = s.trim().split(/\s+as\s+/);
      return (parts[1] ?? parts[0] ?? "").trim();
    });
    if (symbols.includes(name)) return true;
  }
  return false;
}

const ENUM_AFFIXES = ["Schema", "Enum"];

function stripEnumAffixes(name: string): string {
  let core = name;
  for (const affix of ENUM_AFFIXES) {
    if (core.length > affix.length && core.endsWith(affix)) {
      core = core.slice(0, -affix.length);
    }
  }
  // CamelCase → PascalCase: bookingStatus → BookingStatus
  if (core.length > 0) {
    core = core.charAt(0).toUpperCase() + core.slice(1);
  }
  return core;
}
