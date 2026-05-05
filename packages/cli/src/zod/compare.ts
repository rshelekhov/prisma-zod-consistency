/**
 * Structured comparison of a Zod object schema against a Prisma model.
 *
 * Returns a list of typed `SchemaIssue` records — issue *what*, with the
 * field locations and operands needed by handlers (R01a, R01b) to produce
 * findings, suggestions, and fixes.
 *
 * The core walk used to live inside `r01-zod-prisma-drift.ts`. It moved
 * here so both R01a (hand-written → Prisma) and R01b (generator output →
 * Prisma sanity check) can share it. R01c does NOT use this comparator —
 * it compares one Zod schema against another Zod schema, not against
 * Prisma — and lives in `weaken.ts`.
 */

import type { FieldInfo, PrismaModelRegistry } from "../schema/prisma-models.js";
import type { ZodChainCall, ZodField, ZodSchemaInfo } from "./discover.js";

export type SchemaIssue =
  | TypeMismatchIssue
  | ArrayMismatchIssue
  | MissingIntIssue
  | MissingMaxIssue
  | LooseMaxIssue;

export interface BaseIssue {
  prismaField: FieldInfo;
  zodField: ZodField;
  zod: ZodSchemaInfo;
}

export interface TypeMismatchIssue extends BaseIssue {
  kind: "type-mismatch";
  /** Expected zod base types (one or more, e.g. `["string","coerce.string"]`). */
  expected: string[];
  /** Observed zod base type. */
  actual: string;
}

export interface ArrayMismatchIssue extends BaseIssue {
  kind: "array-mismatch";
  /** Expected inner element zod base type per Prisma element type. */
  expectedInner: string[];
  /** Observed (non-array) zod base type. */
  actual: string;
}

export interface MissingIntIssue extends BaseIssue {
  kind: "missing-int";
  /** Source-offset insertion point where `.int()` would land. */
  insertPos: number;
}

export interface MissingMaxIssue extends BaseIssue {
  kind: "missing-max";
  /** `@db.VarChar(N)` size from Prisma. */
  dbSize: number;
  /** `VarChar` / `Char` / etc. */
  dbKind: string;
  /** Source-offset insertion point where `.max(N)` would land. */
  insertPos: number;
}

export interface LooseMaxIssue extends BaseIssue {
  kind: "loose-max";
  /** `@db.VarChar(N)` size from Prisma. */
  dbSize: number;
  /** `VarChar` / `Char` / etc. */
  dbKind: string;
  /** Current `.max(M)` size (M > N). */
  zodMax: number;
  /** Source range of just the `M` literal — for `pz-fix` to overwrite. */
  maxArgRange?: { start: number; end: number };
}

/**
 * Walks every Prisma field and accumulates issues against the matching
 * Zod field. Skips relation fields and enum-typed fields (R03 territory).
 */
export function compareModelToSchemaShape(
  prismaFields: FieldInfo[],
  zod: ZodSchemaInfo,
  registry: PrismaModelRegistry,
): SchemaIssue[] {
  if (zod.shape.kind !== "object") return [];

  const issues: SchemaIssue[] = [];
  const zodByName = new Map(zod.shape.fields.map((f) => [f.name, f]));

  for (const prismaField of prismaFields) {
    if (isRelationField(prismaField, registry)) continue;
    if (registry.enums.has(prismaField.type)) continue; // R03 territory
    const zodField = zodByName.get(prismaField.name);
    if (!zodField) continue; // schema may legitimately omit fields (DTO subset)

    pushIfDefined(issues, checkType(prismaField, zodField, zod));
    pushIfDefined(issues, checkVarcharMax(prismaField, zodField, zod));
  }

  return issues;
}

function pushIfDefined<T>(arr: T[], value: T | undefined): void {
  if (value !== undefined) arr.push(value);
}

function isRelationField(field: FieldInfo, registry: PrismaModelRegistry): boolean {
  if (registry.models.has(field.type)) return true;
  return field.attributes.some((attr) => attr.name === "relation");
}

function checkType(
  prismaField: FieldInfo,
  zodField: ZodField,
  zod: ZodSchemaInfo,
): SchemaIssue | undefined {
  if (prismaField.isArray) {
    if (zodField.baseType !== "array") {
      return {
        kind: "array-mismatch",
        prismaField,
        zodField,
        zod,
        expectedInner: expectedZodBaseTypes(prismaField.type),
        actual: zodField.baseType,
      };
    }
    return undefined;
  }

  const expected = expectedZodBaseTypes(prismaField.type);
  if (expected.length === 0) return undefined; // unknown Prisma scalar — don't false-positive

  if (!expected.includes(zodField.baseType)) {
    return {
      kind: "type-mismatch",
      prismaField,
      zodField,
      zod,
      expected,
      actual: zodField.baseType,
    };
  }

  if (prismaField.type === "Int" && !hasChainCall(zodField.chain, "int")) {
    return {
      kind: "missing-int",
      prismaField,
      zodField,
      zod,
      insertPos: insertBeforeNullishModifiers(zodField),
    };
  }

  return undefined;
}

function checkVarcharMax(
  prismaField: FieldInfo,
  zodField: ZodField,
  zod: ZodSchemaInfo,
): SchemaIssue | undefined {
  const dbSize = prismaField.dbAttribute?.size;
  const dbKind = prismaField.dbAttribute?.kind;
  if (!dbSize || !isVarcharLike(dbKind)) return undefined;

  const zodMax = readMaxConstraint(zodField.chain);
  if (zodMax === undefined) {
    return {
      kind: "missing-max",
      prismaField,
      zodField,
      zod,
      dbSize,
      dbKind: dbKind ?? "",
      insertPos: insertBeforeNullishModifiers(zodField),
    };
  }

  if (zodMax > dbSize) {
    const arr = findMaxArgRange(zodField);
    return {
      kind: "loose-max",
      prismaField,
      zodField,
      zod,
      dbSize,
      dbKind: dbKind ?? "",
      zodMax,
      ...(arr ? { maxArgRange: arr } : {}),
    };
  }

  return undefined;
}

function findMaxArgRange(zodField: ZodField): { start: number; end: number } | undefined {
  const max = zodField.chain.find((c) => c.name === "max");
  return max?.argRanges?.[0];
}

/**
 * Returns the source offset where a constraint like `.int()` or `.max(N)` should
 * be inserted so it sits *before* any `.nullable()` / `.optional()` / `.nullish()`
 * modifier. Mirrors the convention used by the existing R01a codemod.
 */
function insertBeforeNullishModifiers(zodField: ZodField): number {
  const NULLISH = new Set(["nullable", "optional", "nullish"]);
  const first = zodField.chain.find((c) => NULLISH.has(c.name));
  return first?.callStart ?? zodField.exprEnd;
}

export function expectedZodBaseTypes(prismaType: string): string[] {
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
