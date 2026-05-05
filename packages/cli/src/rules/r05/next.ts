/**
 * R05 — Next.js detector.
 *
 * Next.js exposes three semantically distinct surfaces where untrusted client
 * data enters the server. Each gets its own sub-walker:
 *
 *   - App Router Route Handlers (`app/**\/route.{ts,tsx,js,jsx}`):
 *       `<request>.json()`, `<request>.formData()`, `<request>.blob()`,
 *       `<request>.arrayBuffer()` — direct reads off the Request/NextRequest
 *       object. `.text()` is intentionally NOT flagged (legitimate for
 *       webhooks / signature verification — see R05 spec).
 *
 *   - Server Actions (any file with a `'use server'` directive, file-level
 *     OR inline as the first statement of an async function):
 *       a `FormData` parameter read via `<formData>.get(...)`,
 *       `getAll(...)`, `has(...)`, `entries(...)`, `values(...)`, `keys(...)`
 *       without a preceding `<schema>.parse(<formData>)` or
 *       `<schema>.parse(Object.fromEntries(<formData>))` in the same function
 *       body.
 *
 *   - Pages Router API (`pages/api/**\/*.{ts,tsx,js,jsx}`):
 *       `<req>.body` PropertyAccessExpression directly off the first
 *       parameter of the default-exported handler.
 *
 * Files importing known validator wrappers (`next-safe-action`, `zsa`,
 * `zact`) are skipped wholesale — those projects have wrapped Server Actions
 * and the wrapper library guarantees a Zod parse.
 *
 * Surface gating is path-based (Route Handler / Pages API) or directive-based
 * (Server Actions can live in any file). The same file can host more than
 * one surface (e.g. an `app/page.tsx` with both a Server Component and an
 * inline action), so sub-walkers are non-exclusive.
 *
 * Known limitations (documented in the spec):
 *   - `<request>.text()` not flagged — high false-positive rate for webhooks.
 *   - `<request>.body` direct stream access (`.body.getReader()`) not flagged
 *     — rare and used for streaming/SSE.
 *   - For Route Handlers, hand-rolled `schema.parse(await request.json())` is
 *     NOT auto-skipped — flag still emits, suppress per-line if intended.
 *     Tracking the dataflow request → parse is fragile and we'd rather flag
 *     and let the user suppress than silently miss real bypasses.
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

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]);

/** Methods we consider "untyped reads" off a Request/NextRequest. */
const REQUEST_BYPASS_METHODS = new Set(["json", "formData", "blob", "arrayBuffer"]);

/** FormData reader methods. Any of these without a preceding parse → bypass. */
const FORM_DATA_READERS = new Set(["get", "getAll", "has", "entries", "values", "keys"]);

const NEXT_IMPORT_PATTERN = /from\s+["']next(\/[^"']*)?["']/;
const USE_SERVER_DIRECTIVE = /(^|\n)\s*["']use server["']\s*;?/;

/** Wrapper libraries that take care of Zod validation themselves. */
const KNOWN_WRAPPERS = ["next-safe-action", "zsa", "zact"];

const APP_ROUTE_HANDLER_PATH = /(^|\/)app\/.*\/route\.(ts|tsx|js|jsx)$/;
const PAGES_API_PATH = /(^|\/)pages\/api\/.*\.(ts|tsx|js|jsx)$/;

/**
 * Cheap pre-scan: is this project using Next.js at all? Used by the
 * `framework: "auto"` dispatch in r05-validated-bypass.ts.
 *
 * Two signals are accepted:
 *   1. Any source file with a Next-conventional path (app/* /route.ts or
 *      pages/api/*).
 *   2. Any source file importing from `next` / `next/*`.
 *   3. Any source file that begins with a `'use server'` directive (covers
 *      Server Actions in projects without an obvious next/* import).
 */
export async function hasNextFile(ctx: ProjectContext): Promise<boolean> {
  for (const file of ctx.sourceFiles) {
    if (APP_ROUTE_HANDLER_PATH.test(file)) return true;
    if (PAGES_API_PATH.test(file)) return true;
    const source = await readFile(file, "utf8").catch(() => "");
    if (NEXT_IMPORT_PATTERN.test(source)) return true;
    if (USE_SERVER_DIRECTIVE.test(source)) return true;
  }
  return false;
}

/** Walk every source file; emit Findings for any of the three Next surfaces. */
export async function findNextBypasses(
  ctx: ProjectContext,
  project: Project,
  options: RuleOptions,
): Promise<Finding[]> {
  const findings: Finding[] = [];

  for (const file of ctx.sourceFiles) {
    const source = await readFile(file, "utf8");

    const isRouteHandler = APP_ROUTE_HANDLER_PATH.test(file);
    const isPagesApi = PAGES_API_PATH.test(file);
    const mentionsUseServer = /["']use server["']/.test(source);

    if (!isRouteHandler && !isPagesApi && !mentionsUseServer) continue;
    if (importsKnownWrapper(source)) continue;

    const sourceFile = project.createSourceFile(file, source, { overwrite: true });

    if (isRouteHandler) {
      findings.push(...findRouteHandlerBypasses(sourceFile, options));
    }
    if (isPagesApi) {
      findings.push(...findPagesApiBypasses(sourceFile, options));
    }
    if (mentionsUseServer) {
      findings.push(...findServerActionBypasses(sourceFile, options));
    }
  }

  return findings;
}

function importsKnownWrapper(source: string): boolean {
  return KNOWN_WRAPPERS.some((lib) =>
    new RegExp(`from\\s+["']${escapeRegExp(lib)}["']`).test(source),
  );
}

// ---------- Surface 1: App Router Route Handlers ----------

/**
 * For each named export matching an HTTP method (GET/POST/…), walk its body
 * and emit findings on direct `<request>.json()` / `formData()` / `blob()` /
 * `arrayBuffer()` calls.
 */
function findRouteHandlerBypasses(sourceFile: SourceFile, options: RuleOptions): Finding[] {
  const findings: Finding[] = [];

  for (const stmt of sourceFile.getStatements()) {
    if (!Node.isFunctionDeclaration(stmt)) continue;
    if (!stmt.isExported() && !stmt.hasExportKeyword()) continue;
    const name = stmt.getName();
    if (!name || !HTTP_METHODS.has(name)) continue;
    const reqParam = stmt.getParameters()[0];
    if (!reqParam) continue;
    const reqName = paramIdentifierName(reqParam);
    if (!reqName) continue;
    const body = stmt.getBody();
    if (!body) continue;
    findings.push(...findRequestBypasses(sourceFile, body, reqName, options, "Route Handler"));
  }

  // Also handle `export const POST = async (req) => {…}` form.
  for (const decl of sourceFile.getVariableDeclarations()) {
    if (!decl.isExported()) continue;
    const name = decl.getName();
    if (!HTTP_METHODS.has(name)) continue;
    const init = decl.getInitializer();
    if (!init) continue;
    if (!Node.isArrowFunction(init) && !Node.isFunctionExpression(init)) continue;
    const reqParam = init.getParameters()[0];
    if (!reqParam) continue;
    const reqName = paramIdentifierName(reqParam);
    if (!reqName) continue;
    const body = init.getBody();
    if (!body) continue;
    findings.push(...findRequestBypasses(sourceFile, body, reqName, options, "Route Handler"));
  }

  return findings;
}

function findRequestBypasses(
  sourceFile: SourceFile,
  body: Node,
  reqName: string,
  options: RuleOptions,
  surface: "Route Handler",
): Finding[] {
  const findings: Finding[] = [];

  body.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) return;
    const call = node as CallExpression;
    const expr = call.getExpression();
    if (!Node.isPropertyAccessExpression(expr)) return;
    const access = expr as PropertyAccessExpression;
    const methodName = access.getName();
    if (!REQUEST_BYPASS_METHODS.has(methodName)) return;
    const target = access.getExpression();
    if (!Node.isIdentifier(target)) return;
    if (target.getText() !== reqName) return;

    const { line } = sourceFile.getLineAndColumnAtPos(call.getStart());
    findings.push({
      ruleId: "R05",
      severity: options.severity,
      message: `Next.js ${surface}: \`${reqName}.${methodName}()\` reads untyped client data without going through a Zod-validated boundary.`,
      location: { file: sourceFile.getFilePath(), line },
      suggestion: `Parse the result through a Zod schema (e.g. \`schema.parse(await ${reqName}.${methodName}())\`) or wrap the handler with a validator like next-safe-action.`,
    });
  });

  return findings;
}

// ---------- Surface 2: Server Actions ----------

interface ActionCandidate {
  /** The function node whose body contains the action logic. */
  fn:
    | import("ts-morph").FunctionDeclaration
    | import("ts-morph").FunctionExpression
    | import("ts-morph").ArrowFunction
    | import("ts-morph").MethodDeclaration;
  /** What surfaced this function as an Action — used for messaging. */
  origin: "file-level" | "inline";
}

function findServerActionBypasses(sourceFile: SourceFile, options: RuleOptions): Finding[] {
  const findings: Finding[] = [];

  const fileLevel = hasFileLevelUseServer(sourceFile);
  const candidates: ActionCandidate[] = [];

  if (fileLevel) {
    // In a `'use server'` file, every EXPORTED async function is a Server
    // Action. Non-exported async helpers are out of scope — they may be
    // called with already-parsed data by the Action itself, and flagging
    // them produces false positives on routine internal helpers.
    for (const fn of sourceFile.getFunctions()) {
      if (!fn.isExported()) continue;
      if (!isAsync(fn)) continue;
      candidates.push({ fn, origin: "file-level" });
    }
    for (const decl of sourceFile.getVariableDeclarations()) {
      if (!decl.isExported()) continue;
      const init = decl.getInitializer();
      if (!init) continue;
      if (Node.isArrowFunction(init) || Node.isFunctionExpression(init)) {
        if (isAsync(init)) candidates.push({ fn: init, origin: "file-level" });
      }
    }
  } else {
    // Look for inline `'use server'` directives in any async function.
    sourceFile.forEachDescendant((node) => {
      if (
        !Node.isFunctionDeclaration(node) &&
        !Node.isFunctionExpression(node) &&
        !Node.isArrowFunction(node) &&
        !Node.isMethodDeclaration(node)
      ) {
        return;
      }
      if (!isAsync(node)) return;
      if (!hasInlineUseServer(node)) return;
      candidates.push({ fn: node, origin: "inline" });
    });
  }

  for (const candidate of candidates) {
    findings.push(...findFormDataBypasses(sourceFile, candidate, options));
  }

  return findings;
}

function hasFileLevelUseServer(sourceFile: SourceFile): boolean {
  const first = sourceFile.getStatements()[0];
  if (!first) return false;
  return isUseServerDirective(first);
}

function hasInlineUseServer(
  fn:
    | import("ts-morph").FunctionDeclaration
    | import("ts-morph").FunctionExpression
    | import("ts-morph").ArrowFunction
    | import("ts-morph").MethodDeclaration,
): boolean {
  const body = fn.getBody();
  if (!body) return false;
  if (!Node.isBlock(body)) return false;
  const first = body.getStatements()[0];
  if (!first) return false;
  return isUseServerDirective(first);
}

function isUseServerDirective(stmt: Node): boolean {
  if (!Node.isExpressionStatement(stmt)) return false;
  const expr = stmt.getExpression();
  if (!Node.isStringLiteral(expr) && !Node.isNoSubstitutionTemplateLiteral(expr)) return false;
  return expr.getLiteralText() === "use server";
}

function isAsync(
  fn:
    | import("ts-morph").FunctionDeclaration
    | import("ts-morph").FunctionExpression
    | import("ts-morph").ArrowFunction
    | import("ts-morph").MethodDeclaration,
): boolean {
  // ts-morph's hasModifier signature varies by node — use the text scan,
  // which is reliable across all four shapes.
  const modifiers = fn.getModifiers?.() ?? [];
  return modifiers.some((m) => m.getText() === "async");
}

function findFormDataBypasses(
  sourceFile: SourceFile,
  candidate: ActionCandidate,
  options: RuleOptions,
): Finding[] {
  const findings: Finding[] = [];
  const params = candidate.fn.getParameters();
  if (params.length === 0) return findings;

  // Pick the parameter that looks like FormData — by type annotation, type
  // text, or by parameter name (`formData` / `form`). Falls back to the first
  // param if its type name contains "FormData".
  let formDataParamName: string | null = null;
  for (const param of params) {
    const name = paramIdentifierName(param);
    if (!name) continue;
    const typeNode = param.getTypeNode();
    const typeText = typeNode?.getText() ?? "";
    if (typeText === "FormData" || typeText.includes("FormData")) {
      formDataParamName = name;
      break;
    }
    if (name === "formData" || name === "form") {
      formDataParamName = name;
      break;
    }
  }
  if (!formDataParamName) return findings;

  const body = candidate.fn.getBody();
  if (!body) return findings;

  // If the function already calls `<schema>.parse(<formData>)` or
  // `<schema>.parse(Object.fromEntries(<formData>))`, treat it as validated.
  if (bodyParsesFormData(body, formDataParamName)) return findings;

  // Find every `<formData>.get(...)` / `getAll(...)` / etc. and flag.
  body.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) return;
    const call = node as CallExpression;
    const expr = call.getExpression();
    if (!Node.isPropertyAccessExpression(expr)) return;
    const access = expr as PropertyAccessExpression;
    const methodName = access.getName();
    if (!FORM_DATA_READERS.has(methodName)) return;
    const target = access.getExpression();
    if (!Node.isIdentifier(target)) return;
    if (target.getText() !== formDataParamName) return;

    const { line } = sourceFile.getLineAndColumnAtPos(call.getStart());
    findings.push({
      ruleId: "R05",
      severity: options.severity,
      message: `Next.js Server Action (${candidate.origin}): \`${formDataParamName}.${methodName}(...)\` reads untyped client data without a Zod parse.`,
      location: { file: sourceFile.getFilePath(), line },
      suggestion: `Validate via \`schema.parse(Object.fromEntries(${formDataParamName}))\` (or use a wrapper like next-safe-action).`,
    });
  });

  return findings;
}

/**
 * True iff the function body calls `<id>.parse(<formDataParam>)` or
 * `<id>.parse(Object.fromEntries(<formDataParam>))`. Conservative — any
 * matching shape disables FormData findings for the entire body.
 */
function bodyParsesFormData(body: Node, formDataParamName: string): boolean {
  let parsed = false;
  body.forEachDescendant((node, traversal) => {
    if (parsed) {
      traversal.stop();
      return;
    }
    if (!Node.isCallExpression(node)) return;
    const callee = node.getExpression();
    if (!Node.isPropertyAccessExpression(callee)) return;
    if (callee.getName() !== "parse" && callee.getName() !== "safeParse") return;
    const args = node.getArguments();
    if (args.length === 0) return;
    const arg = args[0];

    // Direct: schema.parse(formData)
    if (Node.isIdentifier(arg) && arg.getText() === formDataParamName) {
      parsed = true;
      return;
    }
    // Wrapped: schema.parse(Object.fromEntries(formData))
    if (Node.isCallExpression(arg)) {
      const inner = arg.getExpression();
      const innerArgs = arg.getArguments();
      if (
        Node.isPropertyAccessExpression(inner) &&
        inner.getName() === "fromEntries" &&
        innerArgs.length > 0
      ) {
        const innerArg = innerArgs[0];
        if (Node.isIdentifier(innerArg) && innerArg.getText() === formDataParamName) {
          parsed = true;
          return;
        }
      }
    }
  });
  return parsed;
}

// ---------- Surface 3: Pages Router API ----------

function findPagesApiBypasses(sourceFile: SourceFile, options: RuleOptions): Finding[] {
  const findings: Finding[] = [];

  const handler = resolveDefaultExportFunction(sourceFile);
  if (!handler) return findings;
  const reqParam = handler.getParameters()[0];
  if (!reqParam) return findings;
  const reqName = paramIdentifierName(reqParam);
  if (!reqName) return findings;
  const body = handler.getBody();
  if (!body) return findings;

  // Skip if already going through a Zod parse on req.body.
  if (bodyParsesReqBody(body, reqName)) return findings;

  body.forEachDescendant((node) => {
    if (!Node.isPropertyAccessExpression(node)) return;
    const access = node as PropertyAccessExpression;
    if (access.getName() !== "body") return;
    const target = access.getExpression();
    if (!Node.isIdentifier(target)) return;
    if (target.getText() !== reqName) return;

    const { line } = sourceFile.getLineAndColumnAtPos(access.getStart());
    findings.push({
      ruleId: "R05",
      severity: options.severity,
      message: `Next.js Pages API: \`${reqName}.body\` accesses untyped client data without a Zod parse.`,
      location: { file: sourceFile.getFilePath(), line },
      suggestion: `Parse via \`schema.parse(${reqName}.body)\` before using the data.`,
    });
  });

  return findings;
}

function resolveDefaultExportFunction(
  sourceFile: SourceFile,
):
  | import("ts-morph").FunctionDeclaration
  | import("ts-morph").FunctionExpression
  | import("ts-morph").ArrowFunction
  | null {
  // 1) `export default function handler(req, res) {…}`
  for (const fn of sourceFile.getFunctions()) {
    if (fn.isDefaultExport()) return fn;
  }
  // 2) `export default <expression>` — could be an arrow/fn expression or an
  //    identifier referring to a named declaration earlier in the file.
  const exportAssign = sourceFile.getExportAssignment((ea) => !ea.isExportEquals());
  if (exportAssign) {
    const expr = exportAssign.getExpression();
    if (Node.isArrowFunction(expr) || Node.isFunctionExpression(expr)) return expr;
    if (Node.isIdentifier(expr)) {
      const name = expr.getText();
      const fn = sourceFile.getFunction(name);
      if (fn) return fn;
      const variable = sourceFile.getVariableDeclaration(name);
      if (variable) {
        const init = variable.getInitializer();
        if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
          return init;
        }
      }
    }
  }
  return null;
}

function bodyParsesReqBody(body: Node, reqName: string): boolean {
  let parsed = false;
  body.forEachDescendant((node, traversal) => {
    if (parsed) {
      traversal.stop();
      return;
    }
    if (!Node.isCallExpression(node)) return;
    const callee = node.getExpression();
    if (!Node.isPropertyAccessExpression(callee)) return;
    if (callee.getName() !== "parse" && callee.getName() !== "safeParse") return;
    const args = node.getArguments();
    if (args.length === 0) return;
    const arg = args[0];
    // schema.parse(req.body)
    if (Node.isPropertyAccessExpression(arg)) {
      if (arg.getName() !== "body") return;
      const target = arg.getExpression();
      if (Node.isIdentifier(target) && target.getText() === reqName) {
        parsed = true;
      }
    }
  });
  return parsed;
}

// ---------- shared helpers ----------

function paramIdentifierName(param: import("ts-morph").ParameterDeclaration): string | null {
  const nameNode = param.getNameNode();
  if (Node.isIdentifier(nameNode)) return nameNode.getText();
  // Destructured parameters don't have a usable identifier we can match
  // bypass calls against — skip those (rare in Next handlers).
  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
