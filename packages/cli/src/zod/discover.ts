/**
 * Zod schema discovery via ts-morph.
 *
 * Walks the project's TypeScript source files, finds top-level Zod schema
 * declarations (`export const x = z.object({...})` and similar), and parses
 * each into a structured `ZodSchemaInfo`.
 *
 * The output is intentionally narrow — we only capture what current rules
 * need (z.object field shapes + chained constraints, plus z.enum/z.nativeEnum
 * for R03). Unrecognized Zod constructs are surfaced as `{ kind: "other" }`
 * so rules can choose to skip them rather than crash.
 */

import { readFile } from "node:fs/promises";
import {
  type CallExpression,
  type Identifier,
  Node,
  type ObjectLiteralExpression,
  Project,
  type PropertyAccessExpression,
  type SourceFile,
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
  | { kind: "other"; expression: string };

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
}

export async function discoverZodSchemas(files: string[]): Promise<ZodSchemaInfo[]> {
  if (files.length === 0) return [];

  const project = new Project({
    useInMemoryFileSystem: false,
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { allowJs: false, noEmit: true },
  });

  const schemas: ZodSchemaInfo[] = [];

  for (const file of files) {
    const source = await readFile(file, "utf8");
    if (!hasZodImport(source)) continue;
    const sourceFile = project.createSourceFile(file, source, { overwrite: true });
    schemas.push(...extractFromSourceFile(sourceFile));
  }

  return schemas;
}

function hasZodImport(source: string): boolean {
  // Quick reject — avoids paying for ts-morph parse on files that don't use zod.
  return /from\s+["']zod["']/.test(source);
}

function extractFromSourceFile(sourceFile: SourceFile): ZodSchemaInfo[] {
  const result: ZodSchemaInfo[] = [];

  for (const variable of sourceFile.getVariableDeclarations()) {
    const initializer = variable.getInitializer();
    if (!initializer) continue;
    if (!Node.isCallExpression(initializer)) continue;
    if (!isZodChainRoot(initializer)) continue;

    const shape = extractShape(initializer);
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

function isZodChainRoot(call: CallExpression): boolean {
  // True if the chain ultimately roots at the `z` identifier.
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
      return (cursor as Identifier).getText() === "z";
    }
    return false;
  }
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
        steps.unshift({
          method: pa.getName(),
          argTexts: call.getArguments().map((a) => a.getText()),
          argNodes: call.getArguments().filter(Node.isNode),
        });
        cursor = pa.getExpression();
        continue;
      }
      // Bare identifier call (e.g. `someFn()`) — unsupported root form.
      return steps;
    }
    if (Node.isPropertyAccessExpression(cursor)) {
      const pa = cursor as PropertyAccessExpression;
      steps.unshift({ method: pa.getName(), argTexts: [], argNodes: [] });
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
