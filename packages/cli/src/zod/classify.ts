/**
 * Per-schema R01 classifier.
 *
 * Decides which R01 sub-mode applies to each Zod schema *individually*
 * rather than picking a single mode for the whole project. This matches
 * how real hybrid codebases look: in one file you can have
 *
 *   const userPublicSchema = z.object({ id: z.string(), name: z.string() }); // R01a
 *   const createUserSchema = UserSchema.passthrough();                      // R01c
 *
 * Classification rules (checked in order):
 *   1. The schema's *file* lives inside the generator `outputDir` →
 *      `r01b` (sanity-check the generator output against Prisma).
 *   2. The schema's *shape* is `derived` AND its base identifier resolves
 *      to a file inside `outputDir` (origin populated by discover.ts) →
 *      `r01c` (weakening check).
 *   3. The schema's shape is `object` → `r01a` (compare to Prisma model
 *      by naming match).
 *   4. Anything else (lone derived chain whose base doesn't trace back to
 *      the generator, opaque "other" shapes) → `skip`.
 *
 * Path-based design notes are in `project_r01_dispatch_design.md`.
 */

import { resolve } from "node:path";
import type { ZodSchemaInfo } from "./discover.js";

export type SchemaClassification = "r01a" | "r01b" | "r01c" | "skip";

export interface ClassifyContext {
  /** Absolute path to the Zod-generator outputDir. Undefined when no generator detected. */
  outputDir?: string;
}

export function classifySchema(schema: ZodSchemaInfo, ctx: ClassifyContext): SchemaClassification {
  if (ctx.outputDir && isPathInside(schema.file, ctx.outputDir)) {
    // Schema declared inside the generator output — this is the generator
    // emitting its model schema. Compare it against Prisma to flag config
    // drift (`@zod.string.max(50)` against `@db.VarChar(255)`, etc.).
    return schema.shape.kind === "object" ? "r01b" : "skip";
  }

  if (schema.shape.kind === "derived") {
    // Only classify as R01c when we successfully traced the base identifier
    // back into outputDir. A derived chain in a hand-written project (e.g.
    // `mySchema.optional()` where mySchema is a local hand-written schema)
    // is not weakening generated output — let R01a handle the upstream
    // schema separately.
    return schema.shape.origin ? "r01c" : "skip";
  }

  if (schema.shape.kind === "object") {
    return "r01a";
  }

  return "skip";
}

function isPathInside(candidate: string, dir: string): boolean {
  const c = resolve(candidate);
  const d = resolve(dir);
  if (c === d) return true;
  const prefix = d.endsWith("/") ? d : `${d}/`;
  return c.startsWith(prefix);
}
