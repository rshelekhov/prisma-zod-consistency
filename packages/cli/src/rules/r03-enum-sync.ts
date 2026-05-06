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
import { type PrismaModelRegistry, parsePrismaRegistry } from "../schema/prisma-models.js";
import type { Finding, Fix, ProjectContext, Rule, RuleOptions } from "../types.js";
import { type ZodField, type ZodSchemaInfo, discoverZodSchemas } from "../zod/discover.js";
import { matchSchemasToModels } from "../zod/match.js";

interface R03Config {
  ignoreEnums?: string[];
  preferNativeEnum?: boolean;
}

export const r03: Rule = {
  id: "R03",
  name: "Enum sync (Prisma ↔ Zod)",
  description:
    "Detects drift between Prisma enums and their Zod counterparts (missing/extra values, case mismatch, enum-typed fields using non-enum Zod schemas).",
  helpUri:
    "https://github.com/rshelekhov/prisma-zod-consistency/blob/main/packages/checks/rules/R03-enum-sync.md",
  defaultSeverity: "error",

  async run(ctx: ProjectContext, options: RuleOptions): Promise<Finding[]> {
    const config = options.config as R03Config;
    const ignoreEnums = new Set(config.ignoreEnums ?? []);
    const preferNativeEnum = config.preferNativeEnum ?? false;

    const registry = parsePrismaRegistry(ctx.schemaSource);
    const zodSchemas = await discoverZodSchemas(ctx.sourceFiles);

    const findings: Finding[] = [];

    // Build a name → Prisma-enum lookup of every Zod enum schema in the project.
    // Used in Pass 2 to recognize already-correct fields like
    //   .pipe(channelSchema)
    // where `channelSchema` is itself bound to the matching Prisma enum.
    const enumSchemaToPrisma = new Map<string, string>();
    for (const schema of zodSchemas) {
      if (schema.shape.kind !== "enum") continue;
      const matched = matchEnumSchemaToPrisma(schema, registry, ctx.namingPrefixes);
      if (matched) enumSchemaToPrisma.set(schema.name, matched);
    }

    // Pass 1: top-level enum schemas.
    for (const schema of zodSchemas) {
      if (schema.shape.kind !== "enum") continue;
      const matchedEnum = matchEnumSchemaToPrisma(schema, registry, ctx.namingPrefixes);
      if (!matchedEnum) continue;
      if (ignoreEnums.has(matchedEnum)) continue;
      findings.push(...checkTopLevelEnumSchema(schema, matchedEnum, registry, options));
    }

    // Pass 2: enum-typed fields inside object schemas.
    const objectMatches = matchSchemasToModels(zodSchemas, registry, ctx.namingPrefixes);
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
            enumSchemaToPrisma,
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
  namingPrefixes: readonly string[],
): string | undefined {
  if (schema.shape.kind !== "enum") return undefined;
  // For nativeEnum the identifier itself is the most reliable signal.
  const ref = schema.shape.nativeEnumName;
  if (ref && registry.enums.has(ref)) return ref;
  // Zod 4 native-enum shorthand `z.enum(IDENT)` — same name signal.
  const ident = schema.shape.enumIdentifier;
  if (ident && registry.enums.has(ident)) return ident;

  // Otherwise fall back to the schema name with affixes stripped (including
  // any configured leading PascalCase prefix like `Z` in `ZUserRole`).
  const stripped = stripEnumAffixes(schema.name, namingPrefixes);
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

  // Zod 4 native-enum shorthand `z.enum(IDENT)` without TS-resolved values.
  // The identifier already matched a Prisma enum (we wouldn't be here
  // otherwise), so the binding is trusted — no drift to report.
  if (schema.shape.enumIdentifier && schema.shape.values.length === 0) {
    return [];
  }

  // z.enum literals (or Zod 4 with TS-resolved values): set comparison.
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
  enumSchemaToPrisma: Map<string, string>,
): Finding[] {
  const prismaValues = registry.enums.get(prismaEnumName) ?? [];
  if (zodField.baseType !== "enum" && zodField.baseType !== "nativeEnum") {
    // Common idiom: case-insensitive enum coerce via `.transform(...).pipe(z.nativeEnum(Foo))`
    // (or `.pipe(fooSchema)` where fooSchema is itself bound to the Prisma enum).
    // The chain is already correct; flagging it would propose a destructive replacement.
    if (chainAlreadyValidates(zodField, prismaEnumName, enumSchemaToPrisma)) {
      return [];
    }
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

  // Zod 4 native-enum shorthand at field level: `field: z.enum(IDENT)`.
  // Treat exactly like `z.nativeEnum(IDENT)` for the identifier-vs-Prisma
  // comparison. Order matters here — a Prisma-name match should silence the
  // rule even when TS-side resolution failed (the dub case: `PostbackReceiver`
  // imported from a monorepo @prisma/client whose .d.ts isn't in the parse).
  if (zodField.enumIdentifier !== undefined) {
    if (zodField.enumIdentifier === prismaEnumName) {
      // Name match: the binding is trusted. Surface a values-drift finding
      // only when TS-side resolution succeeded AND those values disagree.
      if (zodField.enumValues && zodField.enumValues.length > 0) {
        return diffEnumValues(
          zodField.name,
          zodField.enumValues,
          prismaEnumName,
          prismaValues,
          schema.file,
          zodField.line,
          options,
        );
      }
      return [];
    }
    if (zodField.enumResolved === false) {
      // No TS resolution AND no name match — most likely an external alias
      // we can't see (e.g. a re-exported Prisma client enum under a
      // different name). Surface an info-level note instead of a hard error.
      return [
        {
          ruleId: "R03",
          severity: "info",
          message: `Field \`${zodField.name}\` uses \`z.enum(${zodField.enumIdentifier})\`; could not resolve the enum reference. Verify that it points at \`${prismaEnumName}\`.`,
          location: { file: schema.file, line: zodField.line },
          suggestion: `If the binding is correct, ignore this note. Otherwise switch to \`z.nativeEnum(${prismaEnumName})\` for an explicit reference.`,
          scope: { model: schema.name, field: zodField.name },
        },
      ];
    }
    // TS-resolved but identifier name doesn't match the expected Prisma enum.
    return [
      {
        ruleId: "R03",
        severity: options.severity,
        message: `Field \`${zodField.name}\` uses \`z.enum(${zodField.enumIdentifier})\` but Prisma type is \`${prismaEnumName}\`.`,
        location: { file: schema.file, line: zodField.line },
        suggestion: `Use \`z.nativeEnum(${prismaEnumName})\` (or \`z.enum(${prismaEnumName})\` on Zod 4).`,
        scope: { model: schema.name, field: zodField.name },
      },
    ];
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
 * `z.nativeEnum(EnumName)`, optionally adding (or extending) the import if
 * the symbol isn't already in scope.
 *
 * Import strategy:
 *  - If `EnumName` is already imported anywhere in the file: no import edit.
 *  - Else, if `@prisma/client` is already imported with named imports: extend
 *    the existing `{ ... }` rather than adding a second `import { X } from "@prisma/client"`.
 *  - Else: prepend a new `import { EnumName } from "@prisma/client";`.
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
    edits.push(buildPrismaClientImportEdit(file, source, prismaEnumName));
  }

  return {
    description: `Replace z.${zodField.baseType}() with z.nativeEnum(${prismaEnumName})`,
    edits,
  };
}

/**
 * Decide whether to extend an existing `import { ... } from "@prisma/client"`
 * named-import block, or to prepend a fresh import.
 */
function buildPrismaClientImportEdit(
  file: string,
  source: string,
  symbol: string,
): { file: string; start: number; end: number; newText: string } {
  // Match the first `import { ... } from "@prisma/client"`. Tolerates both
  // `import { ... }` and `import type { ... }` and either quote style.
  const re = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["']@prisma\/client["']/;
  const match = re.exec(source);

  if (!match || match.index === undefined) {
    return {
      file,
      start: 0,
      end: 0,
      newText: `import { ${symbol} } from "@prisma/client";\n`,
    };
  }

  const matchStart = match.index;
  const matchText = match[0];
  // Position of `}` *within* the import statement, in absolute file offsets.
  const closingBraceOffset = matchStart + matchText.lastIndexOf("}");
  const named = match[1] ?? "";

  // Decide spacing for the inserted symbol based on the existing layout.
  const trimmed = named.trim();
  if (trimmed === "") {
    // `import { } from "@prisma/client"` — extremely unusual, but handle it.
    return {
      file,
      start: closingBraceOffset,
      end: closingBraceOffset,
      newText: ` ${symbol} `,
    };
  }
  if (named.includes("\n")) {
    // Multi-line import block — match indentation of the last named entry.
    const lines = named.split("\n");
    const lastLine = lines[lines.length - 1] ?? "";
    const indent = lastLine.match(/^(\s*)/)?.[1] ?? "  ";
    const trailingComma = trimmed.endsWith(",");
    const sep = trailingComma ? "" : ",";
    return {
      file,
      start: closingBraceOffset,
      end: closingBraceOffset,
      newText: `${sep}\n${indent}${symbol},\n`,
    };
  }
  // Single-line: `import { Foo } from "@prisma/client"` — insert before `}`.
  const trailingComma = trimmed.endsWith(",");
  const sep = trailingComma ? " " : ", ";
  return {
    file,
    start: closingBraceOffset,
    end: closingBraceOffset,
    newText: `${sep}${symbol}`,
  };
}

/**
 * True when the field's chain already enforces the expected Prisma enum
 * via a `.pipe(...)` step — common in case-insensitive coerce idioms
 * like `z.string().transform((v) => v.toUpperCase()).pipe(z.nativeEnum(Foo))`.
 *
 * Recognized forms (string match on the pipe argument source):
 *   - `z.nativeEnum(<EnumName>)`          — inline, exact match
 *   - `z.nativeEnum(<EnumName>).<chain>`  — inline with further chain
 *   - `<schemaName>`                      — variable bound to a known enum schema
 *   - `<schemaName>.<chain>`              — same, with `.optional()` etc.
 */
function chainAlreadyValidates(
  field: ZodField,
  expectedEnum: string,
  enumSchemaToPrisma: Map<string, string>,
): boolean {
  for (const call of field.chain) {
    if (call.name !== "pipe") continue;
    const arg = call.args[0];
    if (!arg) continue;

    // Inline `z.nativeEnum(<id>)` — leading whitespace tolerated.
    const inline = arg.match(/^\s*z\s*\.\s*nativeEnum\s*\(\s*([A-Za-z_$][\w$]*)/);
    if (inline?.[1] === expectedEnum) return true;

    // Inline `z.enum([...])` — for the case-insensitive transform pattern,
    // we accept any z.enum literal in the pipe as evidence the author has
    // already constrained the value. We don't validate the literal set here
    // because Pass 1 already covers that for top-level enum schemas.
    if (/^\s*z\s*\.\s*enum\s*\(/.test(arg)) return true;

    // Variable reference: identifier mapped to a known enum schema in this project.
    const ident = arg.match(/^\s*([A-Za-z_$][\w$]*)/);
    if (ident?.[1] && enumSchemaToPrisma.get(ident[1]) === expectedEnum) return true;
  }
  return false;
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
  for (const match of head.matchAll(importRegex)) {
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

function stripEnumAffixes(name: string, namingPrefixes: readonly string[]): string {
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
  // Mirror the model-side prefix strip: `ZUserRole` → `UserRole`. Only
  // applied when the next character is uppercase (so we don't munch into
  // names like `Zone`).
  for (const prefix of namingPrefixes) {
    if (prefix.length === 0) continue;
    if (core.length <= prefix.length) continue;
    if (!core.startsWith(prefix)) continue;
    const nextChar = core.charAt(prefix.length);
    const code = nextChar.charCodeAt(0);
    if (code < 65 || code > 90) continue;
    core = core.slice(prefix.length);
  }
  return core;
}
