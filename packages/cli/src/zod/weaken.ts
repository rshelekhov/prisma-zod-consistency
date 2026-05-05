/**
 * R01c — weakening detection for derived Zod schemas.
 *
 * A "derived" schema starts at an identifier that resolves into the
 * Zod-generator `outputDir` (see `discover.ts > extractDerivedShape`). That
 * makes the chain a deliberate transformation of a generated schema.
 * Most transformations are intentional and safe (`.partial()`, `.pick()`,
 * `.omit()`, `.extend()` with stricter rules). A few weaken the validator:
 *
 *   - `.passthrough()` — defeats the validator entirely; unknown keys flow
 *     into `prisma.create()`. Severity: error.
 *   - `.strip()` is the Zod default; we don't flag it.
 *   - `.nonstrict()` — alias for permissive parsing in older Zod releases.
 *     Severity: warning (still escapes the strict-by-default contract).
 *
 * This file does NOT (yet) inspect the inside of `.extend({...})` to detect
 * a stricter `.email()` being replaced with a plain `.string()`, etc.
 * That's a deeper diff between two Zod object shapes and is tracked as a
 * follow-up: the immediate, high-value finding is `.passthrough()`, which
 * single-handedly justifies R01c.
 */

import type { ZodChainCall, ZodSchemaInfo } from "./discover.js";

export type WeakeningIssue = PassthroughIssue | NonstrictIssue;

export interface PassthroughIssue {
  kind: "passthrough";
  zod: ZodSchemaInfo;
  /** The `.passthrough()` chain call — useful for source-range messaging. */
  call: ZodChainCall;
  /** Origin generated schema's exported name (e.g. "UserSchema"). */
  originExportName: string;
}

export interface NonstrictIssue {
  kind: "nonstrict";
  zod: ZodSchemaInfo;
  call: ZodChainCall;
  originExportName: string;
}

/**
 * Inspect a derived schema's chain for weakening calls. Caller must have
 * already established that `schema.shape.kind === "derived"` and that the
 * origin resolves into outputDir (i.e. classifySchema returned `"r01c"`).
 */
export function detectWeakening(schema: ZodSchemaInfo): WeakeningIssue[] {
  if (schema.shape.kind !== "derived") return [];
  const origin = schema.shape.origin;
  if (!origin) return [];

  const issues: WeakeningIssue[] = [];
  for (const call of schema.shape.chain) {
    if (call.name === "passthrough") {
      issues.push({
        kind: "passthrough",
        zod: schema,
        call,
        originExportName: origin.exportName,
      });
    } else if (call.name === "nonstrict") {
      issues.push({
        kind: "nonstrict",
        zod: schema,
        call,
        originExportName: origin.exportName,
      });
    }
  }
  return issues;
}
