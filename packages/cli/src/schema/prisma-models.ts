/**
 * Typed registry over a parsed `schema.prisma`.
 *
 * Wraps `@mrleebo/prisma-ast` with a small, stable surface so rules can
 * iterate models, fields, attributes, and `@db.*` constraints without
 * dealing with the AST shape directly.
 *
 * Pre-alpha: only the shapes rules currently consume are exposed.
 */

import { readFile } from "node:fs/promises";
import { getSchema } from "@mrleebo/prisma-ast";

export interface ModelInfo {
  name: string;
  /** Physical table name. Honors `@@map("...")`; falls back to the model name as written (no snake_case implied — Prisma's default is the model name unchanged). */
  tableName: string;
  fields: FieldInfo[];
}

export interface FieldInfo {
  name: string;
  /** Prisma scalar/relation type as written, e.g. "String", "Int", "User". */
  type: string;
  isArray: boolean;
  isOptional: boolean;
  attributes: FieldAttribute[];
  /** `@db.*` modifier when present. */
  dbAttribute?: DbAttribute;
  /**
   * Physical DB column name. Honors `@map("name")` and `@map(name: "name")`
   * (positional + named-arg forms), falls back to `name`. Always populated —
   * downstream live-DB rules (R09, R09b, R09c, R09d) compare against this so
   * snake_case-in-DB conventions don't trip false positives.
   */
  columnName: string;
}

export interface FieldAttribute {
  /** Bare attribute name (without `@`), e.g. "id", "unique", "default", "relation". */
  name: string;
  /** Group prefix when present, e.g. "db" for `@db.VarChar`. */
  group?: string;
  /** Positional and keyword arguments, normalized to a small union. */
  args: AttributeArg[];
}

export type AttributeArg =
  | { kind: "literal"; value: string | number | boolean }
  | { kind: "keyValue"; key: string; value: AttributeArgValue }
  | { kind: "array"; values: AttributeArgValue[] }
  | { kind: "function"; name: string }
  | { kind: "unknown" };

export type AttributeArgValue =
  | { kind: "literal"; value: string | number | boolean }
  | { kind: "array"; values: AttributeArgValue[] }
  | { kind: "function"; name: string }
  | { kind: "identifier"; name: string }
  | { kind: "unknown" };

export interface DbAttribute {
  /** e.g. "VarChar", "Text", "Char". */
  kind: string;
  /** First numeric argument when present (e.g. 100 for `@db.VarChar(100)`). */
  size?: number;
}

export interface PrismaModelRegistry {
  models: Map<string, ModelInfo>;
  /** Enum name → ordered list of values, useful for R03. */
  enums: Map<string, string[]>;
}

export async function loadPrismaRegistry(schemaPath: string): Promise<PrismaModelRegistry> {
  const source = await readFile(schemaPath, "utf8");
  return parsePrismaRegistry(source);
}

export function parsePrismaRegistry(source: string): PrismaModelRegistry {
  const schema = getSchema(source);
  const models = new Map<string, ModelInfo>();
  const enums = new Map<string, string[]>();

  for (const block of schema.list) {
    if (isModelBlock(block)) {
      const model = toModelInfo(block);
      models.set(model.name, model);
    } else if (isEnumBlock(block)) {
      enums.set(block.name, extractEnumValues(block));
    }
  }

  return { models, enums };
}

function toModelInfo(block: { name: string; properties: unknown[] }): ModelInfo {
  const fields: FieldInfo[] = [];
  let tableName = block.name; // Prisma default — table name == model name as written.

  for (const property of block.properties) {
    if (isFieldProperty(property)) {
      fields.push(toFieldInfo(property));
      continue;
    }
    if (isBlockAttribute(property)) {
      const mapped = readMapAttribute(property);
      if (mapped) tableName = mapped;
    }
  }
  return { name: block.name, tableName, fields };
}

function readMapAttribute(attr: { name: string; args?: unknown[] }): string | undefined {
  // Block-level `@@map`. Only positional form is meaningful at the model level
  // (Prisma allows `@@map("name")` or `@@map(name: "name")`), so the same
  // dual-form reader covers both. Re-use the unified extractor below.
  if (attr.name !== "map") return undefined;
  return extractMapNameFromRawArgs(attr.args ?? []);
}

/**
 * Read the value of a `@map` / `@@map` attribute from prisma-ast's raw args.
 *
 * Handles both syntaxes Prisma accepts:
 *   - positional:  `@map("created_at")`
 *   - named-arg:   `@map(name: "created_at")`
 *
 * The named-arg form was the proximate cause of bug #7 (formbricks smoke,
 * 2026-05-07): we only accepted the positional form, so 60+ snake_case
 * columns on formbricks were treated as orphans by R09/R09c/R09d.
 *
 * Operates on the raw shape prisma-ast yields rather than our normalized
 * `AttributeArg[]` so we can use the same helper from both the field-level
 * and the model-level readers (the field-level reader normalizes args first;
 * the model-level reader does not).
 */
function extractMapNameFromRawArgs(rawArgs: unknown[]): string | undefined {
  for (const raw of rawArgs) {
    if (!isObject(raw)) continue;
    const value = (raw as { value?: unknown }).value;
    // positional form: prisma-ast hands the literal back at .value directly
    if (typeof value === "string") return stripQuotes(value);
    // named-arg form: .value is a keyValue node `{type:"keyValue", key, value}`
    if (isObject(value)) {
      const tagged = value as { type?: unknown; key?: unknown; value?: unknown };
      if (tagged.type === "keyValue" && tagged.key === "name") {
        if (typeof tagged.value === "string") return stripQuotes(tagged.value);
      }
    }
  }
  return undefined;
}

/**
 * Same intent as the raw-args extractor above, but operates on our
 * already-normalized `AttributeArg[]`. Used inside `toFieldInfo` to compute
 * `columnName` from the parsed field attribute list.
 */
function extractMapNameFromArgs(args: AttributeArg[]): string | undefined {
  for (const arg of args) {
    if (arg.kind === "literal" && typeof arg.value === "string") return arg.value;
    if (arg.kind === "keyValue" && arg.key === "name") {
      const v = arg.value;
      if (v.kind === "literal" && typeof v.value === "string") return v.value;
    }
  }
  return undefined;
}

function isBlockAttribute(
  prop: unknown,
): prop is { type: "attribute"; name: string; args?: unknown[] } {
  return (
    isObject(prop) &&
    (prop as { type?: unknown }).type === "attribute" &&
    typeof (prop as { name?: unknown }).name === "string"
  );
}

function toFieldInfo(prop: {
  name: string;
  fieldType: unknown;
  array?: boolean;
  optional?: boolean;
  attributes?: unknown[];
}): FieldInfo {
  const attributes: FieldAttribute[] = [];
  let dbAttribute: DbAttribute | undefined;

  for (const raw of prop.attributes ?? []) {
    if (!isAttributeNode(raw)) continue;
    const attr = toFieldAttribute(raw);
    attributes.push(attr);
    if (attr.group === "db" && dbAttribute === undefined) {
      dbAttribute = toDbAttribute(attr);
    }
  }

  // Resolve the physical column name once, here, so every consumer downstream
  // can read `field.columnName` instead of re-implementing the same `@map`
  // sniff (and getting the named-arg form wrong, as happened pre-0.8.1).
  const mappedColumn = extractMapColumnFromAttributes(attributes);

  return {
    name: prop.name,
    type: stringifyFieldType(prop.fieldType),
    isArray: Boolean(prop.array),
    isOptional: Boolean(prop.optional),
    attributes,
    columnName: mappedColumn ?? prop.name,
    ...(dbAttribute ? { dbAttribute } : {}),
  };
}

function extractMapColumnFromAttributes(attrs: FieldAttribute[]): string | undefined {
  for (const attr of attrs) {
    if (attr.name !== "map") continue;
    const v = extractMapNameFromArgs(attr.args);
    if (v !== undefined) return v;
  }
  return undefined;
}

function toFieldAttribute(node: {
  name: string;
  group?: string;
  args?: unknown[];
}): FieldAttribute {
  const result: FieldAttribute = {
    name: node.name,
    args: (node.args ?? []).map(toAttributeArg),
  };
  if (node.group !== undefined) {
    result.group = node.group;
  }
  return result;
}

function toAttributeArg(raw: unknown): AttributeArg {
  if (!isObject(raw)) return { kind: "unknown" };
  const value = (raw as { value?: unknown }).value;
  return toArgPayload(value);
}

function toArgPayload(value: unknown): AttributeArg {
  if (typeof value === "string") {
    // prisma-ast preserves the quote marks around string literals; strip them
    // so consumers get the actual value (e.g. `column_name` not `"column_name"`).
    return { kind: "literal", value: stripQuotes(value) };
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return { kind: "literal", value };
  }
  if (Array.isArray(value)) {
    return { kind: "array", values: value.map(toArgValue) };
  }
  if (!isObject(value)) return { kind: "unknown" };
  const tagged = value as { type?: unknown };
  switch (tagged.type) {
    case "keyValue": {
      const kv = value as { key?: unknown; value?: unknown };
      if (typeof kv.key !== "string") return { kind: "unknown" };
      return { kind: "keyValue", key: kv.key, value: toArgValue(kv.value) };
    }
    case "array": {
      const arr = value as { args?: unknown };
      const values = Array.isArray(arr.args) ? arr.args.map(toArgValue) : [];
      return { kind: "array", values };
    }
    case "function": {
      const fn = value as { name?: unknown };
      return { kind: "function", name: typeof fn.name === "string" ? fn.name : "" };
    }
    default:
      return { kind: "unknown" };
  }
}

function toArgValue(value: unknown): AttributeArgValue {
  if (typeof value === "string") {
    // prisma-ast hands back string literals with surrounding quotes preserved.
    return { kind: "literal", value: stripQuotes(value) };
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return { kind: "literal", value };
  }
  if (Array.isArray(value)) {
    return { kind: "array", values: value.map(toArgValue) };
  }
  if (!isObject(value)) return { kind: "unknown" };
  const tagged = value as { type?: unknown };
  switch (tagged.type) {
    case "function": {
      const fn = value as { name?: unknown };
      return { kind: "function", name: typeof fn.name === "string" ? fn.name : "" };
    }
    case "array": {
      const arr = value as { args?: unknown };
      const values = Array.isArray(arr.args) ? arr.args.map(toArgValue) : [];
      return { kind: "array", values };
    }
    default:
      return { kind: "unknown" };
  }
}

function toDbAttribute(attr: FieldAttribute): DbAttribute {
  const result: DbAttribute = { kind: attr.name };
  for (const arg of attr.args) {
    if (arg.kind === "literal" && typeof arg.value === "number") {
      result.size = arg.value;
      return result;
    }
    if (arg.kind === "literal" && typeof arg.value === "string") {
      const parsed = Number.parseInt(arg.value, 10);
      if (!Number.isNaN(parsed)) {
        result.size = parsed;
        return result;
      }
    }
  }
  return result;
}

function extractEnumValues(block: { name: string; enumerators?: unknown[] }): string[] {
  const values: string[] = [];
  for (const raw of block.enumerators ?? []) {
    if (!isObject(raw)) continue;
    const enumerator = raw as { type?: unknown; name?: unknown };
    if (enumerator.type === "enumerator" && typeof enumerator.name === "string") {
      values.push(enumerator.name);
    }
  }
  return values;
}

function stringifyFieldType(type: unknown): string {
  if (typeof type === "string") return type;
  if (isObject(type)) {
    const named = type as { name?: unknown };
    if (typeof named.name === "string") return named.name;
  }
  return "unknown";
}

function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

function isModelBlock(
  block: unknown,
): block is { type: "model"; name: string; properties: unknown[] } {
  return (
    isObject(block) &&
    (block as { type?: unknown }).type === "model" &&
    typeof (block as { name?: unknown }).name === "string" &&
    Array.isArray((block as { properties?: unknown }).properties)
  );
}

function isEnumBlock(
  block: unknown,
): block is { type: "enum"; name: string; enumerators?: unknown[] } {
  return (
    isObject(block) &&
    (block as { type?: unknown }).type === "enum" &&
    typeof (block as { name?: unknown }).name === "string"
  );
}

function isFieldProperty(prop: unknown): prop is {
  type: "field";
  name: string;
  fieldType: unknown;
  array?: boolean;
  optional?: boolean;
  attributes?: unknown[];
} {
  return (
    isObject(prop) &&
    (prop as { type?: unknown }).type === "field" &&
    typeof (prop as { name?: unknown }).name === "string"
  );
}

function isAttributeNode(node: unknown): node is {
  name: string;
  group?: string;
  args?: unknown[];
} {
  return (
    isObject(node) &&
    (node as { type?: unknown }).type === "attribute" &&
    typeof (node as { name?: unknown }).name === "string"
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
