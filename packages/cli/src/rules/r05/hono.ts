/**
 * R05 — Hono detector.
 *
 * Finds calls of the form:
 *   `<x>.req.json()`        — request body
 *   `<x>.req.parseBody()`   — multipart body
 *   `<x>.req.formData()`    — form body
 * where `<x>` is the Hono context (typically `c`, `ctx`, or `context`).
 *
 * Files that themselves implement validation middleware are excluded
 * automatically by detecting an import from `@hono/zod-validator` — that's
 * almost always the wrapper file, which legitimately calls `c.req.json()`
 * inside the validator and re-exposes it via `c.req.valid(...)`.
 */

import { readFile } from "node:fs/promises";
import {
  type CallExpression,
  Node,
  type Project,
  type PropertyAccessExpression,
  type SourceFile,
} from "ts-morph";
import type { Finding, ProjectContext, RuleOptions } from "../../types.js";

const HONO_BYPASS_METHODS = new Set(["json", "parseBody", "formData"]);
const HONO_IMPORT_PATTERN = /from\s+["']hono["']/;
const VALIDATOR_IMPORT_HINTS = ["@hono/zod-validator"];

/** Cheap pre-scan: is there at least one file that imports `hono`? */
export async function hasHonoFile(ctx: ProjectContext): Promise<boolean> {
  for (const file of ctx.sourceFiles) {
    const source = await readFile(file, "utf8").catch(() => "");
    if (HONO_IMPORT_PATTERN.test(source)) return true;
  }
  return false;
}

/** Walk every source file in the project; emit Findings for Hono bypasses. */
export async function findHonoBypasses(
  ctx: ProjectContext,
  project: Project,
  options: RuleOptions,
): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const file of ctx.sourceFiles) {
    const source = await readFile(file, "utf8");
    if (!mightUseHonoRequest(source)) continue;
    if (importsValidator(source)) continue;
    const sourceFile = project.createSourceFile(file, source, { overwrite: true });
    findings.push(...findInFile(sourceFile, options));
  }
  return findings;
}

function mightUseHonoRequest(source: string): boolean {
  return /\.req\.(json|parseBody|formData)\s*\(/.test(source);
}

function importsValidator(source: string): boolean {
  return VALIDATOR_IMPORT_HINTS.some((hint) =>
    new RegExp(`from\\s+["']${escapeRegExp(hint)}["']`).test(source),
  );
}

function findInFile(sourceFile: SourceFile, options: RuleOptions): Finding[] {
  const findings: Finding[] = [];

  sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) return;
    const call = node as CallExpression;
    const expr = call.getExpression();
    if (!Node.isPropertyAccessExpression(expr)) return;
    const methodAccess = expr as PropertyAccessExpression;
    const methodName = methodAccess.getName();
    if (!HONO_BYPASS_METHODS.has(methodName)) return;

    const reqAccess = methodAccess.getExpression();
    if (!Node.isPropertyAccessExpression(reqAccess)) return;
    if ((reqAccess as PropertyAccessExpression).getName() !== "req") return;

    const { line } = sourceFile.getLineAndColumnAtPos(call.getStart());
    findings.push({
      ruleId: "R05",
      severity: options.severity,
      message: `Direct \`.req.${methodName}()\` call bypasses Zod validation.`,
      location: { file: sourceFile.getFilePath(), line },
      suggestion: `Add a \`zValidator("${methodName === "json" ? "json" : "form"}", schema)\` middleware to the route and read with \`c.req.valid(...)\`.`,
    });
  });

  return findings;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
