/**
 * R05 — tRPC detector.
 *
 * Detects tRPC procedures whose handler accepts `input` (or destructures
 * `{ input }`) but no `.input(zodSchema)` is declared earlier in the chain.
 * That's the textbook bypass: untyped data flows into the handler — and
 * often straight into `prisma.X.create({ data: input })` — without a Zod
 * boundary.
 *
 * Detection is import-gated. Only files that import from `@trpc/server`
 * (or any `@trpc/server/...` subpath) are walked; this rules out
 * coincidental `.query(...)` / `.mutation(...)` chains from MongoDB,
 * Prisma, and other libraries that happen to expose those method names.
 *
 * The walker is permissive about how the procedure is named: any identifier
 * (`procedure`, `publicProcedure`, `protectedProcedure`, custom names) at
 * the head of the chain works, because the import gate already ensures the
 * file is genuinely tRPC.
 *
 * What is NOT flagged:
 *   - Handlers with no parameters at all (`.query(() => ...)`).
 *   - Handlers whose first parameter is named anything other than `input`
 *     and which do not destructure `input`.
 *   - Any chain that already has `.input(...)` in it — including
 *     `.input(z.void())`, `.input(z.undefined())`, `.input(z.never())`,
 *     which are explicit no-input declarations.
 */

import { readFile } from "node:fs/promises";
import {
  type CallExpression,
  Node,
  type ParameterDeclaration,
  type Project,
  type PropertyAccessExpression,
  type SourceFile,
} from "ts-morph";
import type { Finding, ProjectContext, RuleOptions } from "../../types.js";

const TRPC_BYPASS_METHODS = new Set(["query", "mutation"]);
const TRPC_IMPORT_PATTERN = /from\s+["']@trpc\/server(\/[^"']*)?["']/;

/** Cheap pre-scan: is there at least one file that imports `@trpc/server`? */
export async function hasTrpcFile(ctx: ProjectContext): Promise<boolean> {
  for (const file of ctx.sourceFiles) {
    const source = await readFile(file, "utf8").catch(() => "");
    if (TRPC_IMPORT_PATTERN.test(source)) return true;
  }
  return false;
}

/** Walk every tRPC source file; emit Findings for procedures missing `.input()`. */
export async function findTrpcBypasses(
  ctx: ProjectContext,
  project: Project,
  options: RuleOptions,
): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const file of ctx.sourceFiles) {
    const source = await readFile(file, "utf8");
    if (!TRPC_IMPORT_PATTERN.test(source)) continue;
    if (!mightDefineProcedure(source)) continue;
    const sourceFile = project.createSourceFile(file, source, { overwrite: true });
    findings.push(...findInFile(sourceFile, options));
  }
  return findings;
}

function mightDefineProcedure(source: string): boolean {
  // Cheap pre-filter: any `.query(` or `.mutation(` worth opening the file for.
  return /\.(query|mutation)\s*\(/.test(source);
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
    if (!TRPC_BYPASS_METHODS.has(methodName)) return;

    // Handler must exist and reference `input`. Without that, no bypass.
    const handler = call.getArguments()[0];
    if (!handler) return;
    if (!Node.isArrowFunction(handler) && !Node.isFunctionExpression(handler)) return;
    const firstParam = handler.getParameters()[0];
    if (!firstParam) return;
    if (!firstParamReferencesInput(firstParam)) return;

    // Walk the chain backwards looking for `.input(...)`.
    if (chainHasInputCall(methodAccess.getExpression())) return;

    const { line } = sourceFile.getLineAndColumnAtPos(call.getStart());
    findings.push({
      ruleId: "R05",
      severity: options.severity,
      message: `tRPC \`.${methodName}(...)\` accepts \`input\` but no \`.input(zodSchema)\` declared in the procedure chain.`,
      location: { file: sourceFile.getFilePath(), line },
      suggestion: `Add \`.input(zSchema)\` before \`.${methodName}(...)\`. Use \`.input(z.void())\` if the procedure intentionally takes no input.`,
    });
  });

  return findings;
}

/** True iff the first parameter is named `input` or destructures an `input` property. */
function firstParamReferencesInput(param: ParameterDeclaration): boolean {
  const nameNode = param.getNameNode();
  if (Node.isIdentifier(nameNode)) {
    return nameNode.getText() === "input";
  }
  if (Node.isObjectBindingPattern(nameNode)) {
    for (const elem of nameNode.getElements()) {
      const propName = elem.getPropertyNameNode();
      if (propName) {
        // `{ input: localName }` — propertyName is what we destructure.
        if (Node.isIdentifier(propName) && propName.getText() === "input") return true;
      } else {
        // `{ input }` — name node IS the property.
        const valueName = elem.getNameNode();
        if (Node.isIdentifier(valueName) && valueName.getText() === "input") return true;
      }
    }
  }
  return false;
}

/**
 * Walk back along a call chain (e.g. `procedure.use(auth).input(z.foo).query`)
 * looking for any `.input(...)` call. Any presence — including
 * `.input(z.void())` — is treated as an explicit declaration.
 */
function chainHasInputCall(expr: Node): boolean {
  let current: Node | undefined = expr;
  while (current) {
    if (Node.isCallExpression(current)) {
      const callee = current.getExpression();
      if (Node.isPropertyAccessExpression(callee) && callee.getName() === "input") {
        return true;
      }
      current = callee;
    } else if (Node.isPropertyAccessExpression(current)) {
      current = current.getExpression();
    } else {
      return false;
    }
  }
  return false;
}
