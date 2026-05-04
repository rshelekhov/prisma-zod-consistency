/**
 * R05 — API boundary bypass.
 *
 * Detects request handlers that read body/query/param data directly from the
 * framework context instead of going through a Zod-validated middleware. The
 * rule is framework-aware: this iteration ships the Hono detector. Other
 * frameworks land via separate detectors keyed off the `framework` config.
 *
 * Hono detector finds calls of the form:
 *   `<x>.req.json()`        — request body
 *   `<x>.req.parseBody()`   — multipart body
 *   `<x>.req.formData()`    — form body
 * where `<x>` is the Hono context (typically `c`, `ctx`, or `context`).
 *
 * Files that themselves implement validation middleware are excluded
 * automatically by detecting an import from `@hono/zod-validator` — that's
 * almost always the wrapper file, which legitimately calls `c.req.json()`
 * inside the validator and re-exposes it via `c.req.valid(...)`.
 *
 * See: packages/checks/rules/R05-validated-bypass.md
 */

import { readFile } from "node:fs/promises";
import {
  type CallExpression,
  Node,
  Project,
  type PropertyAccessExpression,
  type SourceFile,
} from "ts-morph";
import type { Finding, ProjectContext, Rule, RuleOptions } from "../types.js";

interface R05Config {
  framework?: "hono" | "auto" | "off";
  /** Globs of files to exclude from this rule (in addition to the auto-detection). */
  excludeFiles?: string[];
  /** Additional method names that count as validated readers. Default: ["valid"]. */
  validatedReaderNames?: string[];
}

const HONO_BYPASS_METHODS = new Set(["json", "parseBody", "formData"]);
const VALIDATOR_IMPORT_HINTS = ["@hono/zod-validator"];

export const r05: Rule = {
  id: "R05",
  defaultSeverity: "warning",

  async run(ctx: ProjectContext, options: RuleOptions): Promise<Finding[]> {
    const config = options.config as R05Config;
    const framework = config.framework ?? "auto";
    if (framework === "off") return [];

    const isHono = framework === "hono" || (framework === "auto" && (await detectHono(ctx)));
    if (!isHono) return [];

    const project = new Project({
      useInMemoryFileSystem: false,
      skipAddingFilesFromTsConfig: true,
      compilerOptions: { allowJs: false, noEmit: true },
    });

    const findings: Finding[] = [];
    for (const file of ctx.sourceFiles) {
      const source = await readFile(file, "utf8");
      if (!mightUseHonoRequest(source)) continue;
      if (importsValidator(source)) continue;
      const sourceFile = project.createSourceFile(file, source, { overwrite: true });
      findings.push(...findHonoBypasses(sourceFile, options));
    }
    return findings;
  },
};

async function detectHono(ctx: ProjectContext): Promise<boolean> {
  // Cheap: grep one of the source files for `from "hono"`. Avoids opening
  // every file just to determine framework.
  for (const file of ctx.sourceFiles) {
    const source = await readFile(file, "utf8").catch(() => "");
    if (/from\s+["']hono["']/.test(source)) return true;
  }
  return false;
}

function mightUseHonoRequest(source: string): boolean {
  return /\.req\.(json|parseBody|formData)\s*\(/.test(source);
}

function importsValidator(source: string): boolean {
  return VALIDATOR_IMPORT_HINTS.some((hint) =>
    new RegExp(`from\\s+["']${escapeRegExp(hint)}["']`).test(source),
  );
}

function findHonoBypasses(sourceFile: SourceFile, options: RuleOptions): Finding[] {
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
