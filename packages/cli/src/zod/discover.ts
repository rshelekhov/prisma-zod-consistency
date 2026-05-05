/**
 * Zod schema discovery via ts-morph.
 *
 * Walks the project's TypeScript source files, finds top-level Zod schema
 * declarations (`export const x = z.object({...})` and similar), and parses
 * each into a structured `ZodSchemaInfo`.
 *
 * The output captures three shape kinds rules currently consume:
 *   - `object` — `z.object({ ... })` root forms (R01a / R01b base case).
 *   - `enum`   — `z.enum([...])` and `z.nativeEnum(X)` (R03).
 *   - `derived` — chains rooted at a non-`z` identifier such as
 *     `UserSchema.passthrough()` or `UserSchema.pick({...}).extend({...})`.
 *     Used by R01c to detect weakening of generated schemas. When the root
 *     identifier resolves (via ts-morph alias chains, transparently
 *     traversing barrel re-exports and import aliasing) to a file inside
 *     the Zod-generator `outputDir`, the resolved origin is attached.
 *
 * Unrecognized Zod constructs are surfaced as `{ kind: "other" }` so rules
 * can choose to skip them rather than crash.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  type CallExpression,
  type Identifier,
  Node,
  type ObjectLiteralExpression,
  Project,
  type PropertyAccessExpression,
  type SourceFile,
  type Symbol as TsMorphSymbol,
  type VariableDeclaration,
} from "ts-morph";

export interface ZodSchemaInfo {
  /** Variable name (e.g. "userSchema"). */
  name: string;
  /** Absolute file path. */
  file: string;
  /** 1-based line of the variable declaration. */
  line: number;
  shape: ZodShape;
}

export type ZodShape =
  | { kind: "object"; fields: ZodField[] }
  | { kind: "enum"; values: string[]; nativeEnumName?: string }
  | { kind: "derived"; baseIdentifier: string; origin?: DerivationOrigin; chain: ZodChainCall[] }
  | { kind: "other"; expression: string };

/**
 * The original generated schema a derived expression traces back to.
 *
 * Populated by `resolveOriginInGeneratedDir` when the chain's base identifier
 * — after following ts-morph alias chains through any number of barrels and
 * import aliases — points at a declaration inside the configured `outputDir`.
 */
export interface DerivationOrigin {
  /** Absolute path to the source file inside outputDir where the origin schema is declared. */
  file: string;
  /** Exported name of the origin schema (e.g. "UserSchema"). */
  exportName: string;
}

export interface ZodField {
  name: string;
  /** 1-based line of the field declaration. */
  line: number;
  /**
   * The base Zod type as a string ("string", "number", "boolean", "date",
   * "bigint", "array", "object", "literal", "enum", "nativeEnum", "any",
   * "unknown", "never", "null", "undefined", "void", "lazy", "discriminatedUnion",
   * "union", "intersection", "tuple", "record", "map", "set", "function",
   * "promise", "instanceof", "custom", "coerce.string", "coerce.number",
   * "coerce.date", "coerce.bigint", "coerce.boolean", or a custom string
   * for unrecognized types).
   */
  baseType: string;
  /** Method chain calls applied after the base type, in source order. */
  chain: ZodChainCall[];
  /** Inline enum literals when baseType is "enum" (e.g. z.enum(["A","B"])). */
  enumValues?: string[];
  /**
   * Identifier referenced when baseType is "nativeEnum"
   * (e.g. "BookingStatus" for z.nativeEnum(BookingStatus) or z.nativeEnum(prisma.BookingStatus)).
   */
  nativeEnumName?: string;
  /** Character offset (start, inclusive) of the entire field value expression. Used for codemods. */
  exprStart: number;
  /** Character offset (end, exclusive) of the entire field value expression. Used for codemods. */
  exprEnd: number;
  /**
   * Character offset (end, exclusive) of just the base call (`z.string()`,
   * `z.number()`, etc.) before any chained methods. Used by codemods that
   * replace only the base type, e.g. `z.string()` -> `z.nativeEnum(X)`.
   */
  baseEnd: number;
}

export interface ZodChainCall {
  /** Method name (e.g. "max", "email", "optional"). */
  name: string;
  /** Argument list as raw source snippets — sufficient for set/numeric checks. */
  args: string[];
  /** Character offsets of each arg (parallel to `args`). Used for codemods that rewrite a single argument. */
  argRanges?: Array<{ start: number; end: number }>;
  /**
   * Character offset (start, inclusive) of the dot before the method name
   * (e.g. for `.optional()` this points at the leading `.`). Used by
   * codemods that need to insert text *before* a specific chained call,
   * e.g. inserting `.int()` ahead of `.nullable()`.
   */
  callStart: number;
  /** Character offset (end, exclusive) of the closing `)` of this chained call. */
  callEnd: number;
}

/**
 * Options for `discoverZodSchemas`. The string-array form is preserved as
 * a back-compat shorthand: `discoverZodSchemas(["a.ts", "b.ts"])` extracts
 * schemas from those files with no cross-file resolution.
 */
export interface DiscoverZodOptions {
  /** Files to extract schemas from. */
  files: string[];
  /**
   * Additional files to load into the ts-morph Project so that derived-shape
   * identifiers can be resolved across barrel re-exports and import aliases.
   * Schemas are NOT extracted from these files — pass them through `files`
   * if you want both sets in the result.
   */
  resolutionContext?: string[];
  /**
   * Absolute path to the Zod-generator `outputDir`. When set, derived chains
   * whose base identifier ultimately resolves into this directory will have
   * their `origin` populated.
   */
  outputDir?: string;
}

export async function discoverZodSchemas(
  filesOrOptions: string[] | DiscoverZodOptions,
): Promise<ZodSchemaInfo[]> {
  const opts: DiscoverZodOptions = Array.isArray(filesOrOptions)
    ? { files: filesOrOptions }
    : filesOrOptions;

  if (opts.files.length === 0) return [];

  const project = new Project({
    useInMemoryFileSystem: false,
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { allowJs: false, noEmit: true },
  });

  // Load resolution-context files first so cross-file symbol lookups
  // (alias chains through barrels, etc.) work when we walk the target files.
  const contextFiles = uniquePaths(opts.resolutionContext ?? []);
  for (const file of contextFiles) {
    const source = await readFile(file, "utf8").catch(() => undefined);
    if (source === undefined) continue;
    project.createSourceFile(file, source, { overwrite: true });
  }

  const schemas: ZodSchemaInfo[] = [];
  const targetFiles = uniquePaths(opts.files);

  for (const file of targetFiles) {
    const source = await readFile(file, "utf8");
    if (!hasZodImport(source) && !mentionsKnownDerivationBase(source)) continue;
    const sourceFile = project.createSourceFile(file, source, { overwrite: true });
    schemas.push(...extractFromSourceFile(sourceFile, opts.outputDir));
  }

  return schemas;
}

function uniquePaths(files: string[]): string[] {
  return Array.from(new Set(files));
}

/**
 * Files that contain only derived schemas (no `import { z } from "zod"`)
 * still need to be parsed — their root identifier will resolve through
 * ts-morph into a generated schema. This heuristic catches the common case
 * where a file imports a schema from a barrel and immediately calls a
 * Zod chaining method on it. False positives just cost a parse.
 */
function mentionsKnownDerivationBase(source: string): boolean {
  // Capital-led identifier followed by a dot and a method name common to
  // derived chains. Cheap, lossy, intentional.
  return /\b[A-Z][A-Za-z0-9_]*\.(passthrough|partial|pick|omit|extend|merge|strict|strip|nonstrict|nullable|optional|nullish|describe|brand|catch|default|refine|superRefine|transform|pipe)\s*\(/.test(
    source,
  );
}

function hasZodImport(source: string): boolean {
  // Quick reject — avoids paying for ts-morph parse on files that don't use zod.
  return /from\s+["']zod["']/.test(source);
}

function extractFromSourceFile(sourceFile: SourceFile, outputDir?: string): ZodSchemaInfo[] {
  const result: ZodSchemaInfo[] = [];
  const normalizedOutputDir = outputDir ? resolve(outputDir) : undefined;

  for (const variable of sourceFile.getVariableDeclarations()) {
    const initializer = variable.getInitializer();
    if (!initializer) continue;
    if (!Node.isCallExpression(initializer)) continue;

    const root = chainRoot(initializer);
    if (!root) continue;

    let shape: ZodShape | undefined;
    if (root.kind === "z") {
      shape = extractShape(initializer);
    } else if (root.kind === "identifier") {
      shape = extractDerivedShape(initializer, root.identifier, normalizedOutputDir);
    }

    if (shape) {
      result.push({
        name: variable.getName(),
        file: sourceFile.getFilePath(),
        line: lineOf(variable),
        shape,
      });
    }
  }

  return result;
}

type ChainRoot = { kind: "z" } | { kind: "identifier"; identifier: Identifier } | undefined;

function chainRoot(call: CallExpression): ChainRoot {
  let cursor: Node = call;
  while (true) {
    if (Node.isCallExpression(cursor)) {
      cursor = cursor.getExpression();
      continue;
    }
    if (Node.isPropertyAccessExpression(cursor)) {
      cursor = (cursor as PropertyAccessExpression).getExpression();
      continue;
    }
    if (Node.isIdentifier(cursor)) {
      const id = cursor as Identifier;
      if (id.getText() === "z") return { kind: "z" };
      return { kind: "identifier", identifier: id };
    }
    return undefined;
  }
}

function isZodChainRoot(call: CallExpression): boolean {
  return chainRoot(call)?.kind === "z";
}

function extractShape(rootCall: CallExpression): ZodShape | undefined {
  const chain = unwindChain(rootCall);
  if (chain.length === 0) return undefined;

  const root = chain[0];
  if (!root) return undefined;

  if (root.method === "object" && root.argNodes[0]) {
    const obj = root.argNodes[0];
    if (Node.isObjectLiteralExpression(obj)) {
      return { kind: "object", fields: extractObjectFields(obj as ObjectLiteralExpression) };
    }
  }

  if (root.method === "enum" && root.argNodes[0]) {
    const arrayNode = root.argNodes[0];
    if (Node.isArrayLiteralExpression(arrayNode)) {
      const values: string[] = [];
      for (const el of arrayNode.getElements()) {
        if (Node.isStringLiteral(el) || Node.isNoSubstitutionTemplateLiteral(el)) {
          values.push(el.getLiteralText());
        }
      }
      return { kind: "enum", values };
    }
  }

  if (root.method === "nativeEnum" && root.argNodes[0]) {
    const ref = root.argNodes[0];
    if (Node.isIdentifier(ref)) {
      return { kind: "enum", values: [], nativeEnumName: ref.getText() };
    }
    if (Node.isPropertyAccessExpression(ref)) {
      return { kind: "enum", values: [], nativeEnumName: ref.getName() };
    }
  }

  return { kind: "other", expression: rootCall.getText().slice(0, 200) };
}

function extractObjectFields(obj: ObjectLiteralExpression): ZodField[] {
  const result: ZodField[] = [];

  for (const prop of obj.getProperties()) {
    if (!Node.isPropertyAssignment(prop)) continue;
    const name = prop.getName();
    const initializer = prop.getInitializer();
    if (!initializer || !Node.isCallExpression(initializer)) continue;
    if (!isZodChainRoot(initializer)) continue;

    const chain = unwindChain(initializer);
    const head = chain[0];
    if (!head) continue;

    const baseType = chainBaseType(head, chain);
    const trailing = chain.slice(baseTypePrefixLength(chain));
    const baseStep = chain[baseTypePrefixLength(chain) - 1] ?? head;
    const enumExtras = extractEnumExtras(baseType, baseStep);

    const baseCall = findBaseCall(initializer);
    result.push({
      name,
      line: lineOf(prop),
      baseType,
      chain: trailing.map((c) => ({
        name: c.method,
        args: c.argTexts,
        argRanges: c.argNodes.map((node) => ({ start: node.getStart(), end: node.getEnd() })),
        callStart: c.callStart,
        callEnd: c.callEnd,
      })),
      ...enumExtras,
      exprStart: initializer.getStart(),
      exprEnd: initializer.getEnd(),
      baseEnd: baseCall.getEnd(),
    });
  }

  return result;
}

function findBaseCall(initializer: CallExpression): CallExpression {
  let cursor: Node = initializer;
  while (true) {
    if (Node.isCallExpression(cursor)) {
      const call = cursor as CallExpression;
      const expr = call.getExpression();
      if (Node.isPropertyAccessExpression(expr)) {
        const inner = (expr as PropertyAccessExpression).getExpression();
        if (Node.isCallExpression(inner)) {
          cursor = inner;
          continue;
        }
      }
      return call;
    }
    return initializer;
  }
}

function extractEnumExtras(
  baseType: string,
  step: ChainStep,
): Pick<ZodField, "enumValues" | "nativeEnumName"> {
  if (baseType === "enum") {
    const arrayNode = step.argNodes[0];
    if (arrayNode && Node.isArrayLiteralExpression(arrayNode)) {
      const values: string[] = [];
      for (const el of arrayNode.getElements()) {
        if (Node.isStringLiteral(el) || Node.isNoSubstitutionTemplateLiteral(el)) {
          values.push(el.getLiteralText());
        }
      }
      return { enumValues: values };
    }
  }
  if (baseType === "nativeEnum") {
    const ref = step.argNodes[0];
    if (ref && Node.isIdentifier(ref)) {
      return { nativeEnumName: ref.getText() };
    }
    if (ref && Node.isPropertyAccessExpression(ref)) {
      return { nativeEnumName: ref.getName() };
    }
  }
  return {};
}

interface ChainStep {
  method: string;
  argTexts: string[];
  argNodes: Node[];
  callStart: number;
  callEnd: number;
}

/**
 * Walks the chained call expression backwards from the outermost call,
 * returning the methods in source order:
 *   z.string().max(10).email().optional()
 *   →
 *   [{ method: "string" }, { method: "max", args: ["10"] }, { method: "email" }, { method: "optional" }]
 */
function unwindChain(rootCall: CallExpression): ChainStep[] {
  const steps: ChainStep[] = [];
  let cursor: Node = rootCall;

  while (true) {
    if (Node.isCallExpression(cursor)) {
      const call = cursor as CallExpression;
      const expr = call.getExpression();
      if (Node.isPropertyAccessExpression(expr)) {
        const pa = expr as PropertyAccessExpression;
        const nameNode = pa.getNameNode();
        // Dot lives directly before the method name in source, so step back one.
        const dotPos = nameNode.getStart() - 1;
        steps.unshift({
          method: pa.getName(),
          argTexts: call.getArguments().map((a) => a.getText()),
          argNodes: call.getArguments().filter(Node.isNode),
          callStart: dotPos,
          callEnd: call.getEnd(),
        });
        cursor = pa.getExpression();
        continue;
      }
      // Bare identifier call (e.g. `someFn()`) — unsupported root form.
      return steps;
    }
    if (Node.isPropertyAccessExpression(cursor)) {
      const pa = cursor as PropertyAccessExpression;
      const nameNode = pa.getNameNode();
      const dotPos = nameNode.getStart() - 1;
      steps.unshift({
        method: pa.getName(),
        argTexts: [],
        argNodes: [],
        callStart: dotPos,
        callEnd: pa.getEnd(),
      });
      cursor = pa.getExpression();
      continue;
    }
    return steps;
  }
}

function chainBaseType(head: ChainStep, chain: ChainStep[]): string {
  // `z.coerce.date()` shows up as: head={method:"coerce"} then next={method:"date"}
  if (head.method === "coerce" && chain.length >= 2 && chain[1]) {
    return `coerce.${chain[1].method}`;
  }
  return head.method;
}

function baseTypePrefixLength(chain: ChainStep[]): number {
  if (chain.length >= 2 && chain[0]?.method === "coerce") return 2;
  return 1;
}

function lineOf(node: Node | VariableDeclaration): number {
  return node.getSourceFile().getLineAndColumnAtPos(node.getStart()).line;
}

/**
 * Extract a derived chain (`UserSchema.passthrough()`, `UserSchema.pick({...}).extend({...})`).
 * If the base identifier resolves into `outputDir` via ts-morph alias chains,
 * the resolved origin is attached.
 */
function extractDerivedShape(
  rootCall: CallExpression,
  baseIdentifier: Identifier,
  outputDir: string | undefined,
): ZodShape {
  const steps = unwindChain(rootCall);
  // The base identifier doesn't show up as a step in unwindChain (steps only
  // capture .method() segments). All steps are post-base chain calls.
  const chain: ZodChainCall[] = steps.map((c) => ({
    name: c.method,
    args: c.argTexts,
    argRanges: c.argNodes.map((node) => ({ start: node.getStart(), end: node.getEnd() })),
    callStart: c.callStart,
    callEnd: c.callEnd,
  }));

  const result: ZodShape = {
    kind: "derived",
    baseIdentifier: baseIdentifier.getText(),
    chain,
  };

  if (outputDir) {
    const origin = resolveOriginInGeneratedDir(baseIdentifier, outputDir);
    if (origin) {
      return { ...result, origin };
    }
  }

  return result;
}

/**
 * Walk the symbol's alias chain (transparently traversing `import { X } from`,
 * `import { X as Y }`, `export { X } from`, `export * from`, etc.) and check
 * whether the original declaration lives inside `outputDir`.
 *
 * Limitations:
 *   - Dynamic CJS re-exports (`module.exports = { ...require(...) }`) are not
 *     resolved — TypeScript's symbol resolution doesn't see them. Documented
 *     as a known limitation in the R01 spec.
 *   - Requires that all relevant files (target + intermediate barrels +
 *     generated) are loaded into the same ts-morph Project. The caller is
 *     responsible for that via `resolutionContext`.
 */
function resolveOriginInGeneratedDir(
  identifier: Identifier,
  outputDir: string,
): DerivationOrigin | undefined {
  const initial = identifier.getSymbol();
  if (!initial) return undefined;
  let symbol: TsMorphSymbol = initial;

  // Cap the alias-chain walk at 16 hops as a paranoia bound — should never
  // hit it on real codebases, but keeps a malformed graph from looping.
  for (let i = 0; i < 16; i++) {
    const aliased: TsMorphSymbol | undefined = symbol.getAliasedSymbol?.();
    if (!aliased || aliased === symbol) break;
    symbol = aliased;
  }

  const decls = symbol.getDeclarations?.() ?? [];
  if (decls.length === 0) return undefined;

  for (const decl of decls) {
    const declFile = decl.getSourceFile().getFilePath();
    if (isPathInside(declFile, outputDir)) {
      return { file: declFile, exportName: symbol.getName() };
    }
  }
  return undefined;
}

function isPathInside(candidate: string, dir: string): boolean {
  const normalizedCandidate = resolve(candidate);
  const normalizedDir = resolve(dir);
  if (normalizedCandidate === normalizedDir) return true;
  // Trailing separator avoids matching `/foo/barbar` against `/foo/bar`.
  const prefix = normalizedDir.endsWith("/") ? normalizedDir : `${normalizedDir}/`;
  return normalizedCandidate.startsWith(prefix);
}
