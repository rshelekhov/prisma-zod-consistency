/**
 * Extract foreign-key expectations from Prisma `@relation(...)` attributes.
 *
 * R09c consumes `extractExpectedForeignKeys(registry)` to know what FKs the
 * Prisma schema implies, then compares against `DbSnapshot.foreignKeys`.
 *
 * Only the *owner* side of a relation produces an FK — the side with both
 * `fields: [...]` and `references: [...]` set. The "obverse" side
 * (`memberships Membership[]`) is not an FK and is filtered out here.
 *
 * Implicit many-to-many relations (no `fields`/`references`, Prisma manages
 * a hidden join table) are skipped — there's no first-class FK to compare
 * against on the side a user can author.
 *
 * Column resolution honors `@map(...)`: the source column name is whatever
 * `@map` says on the FK-bearing field; the referenced column name is whatever
 * `@map` says on the referenced field in the target model.
 */

import type { ForeignKeyAction } from "../db/types.js";
import type {
  AttributeArg,
  AttributeArgValue,
  FieldAttribute,
  FieldInfo,
  ModelInfo,
  PrismaModelRegistry,
} from "./prisma-models.js";

/**
 * The expected shape of a foreign key implied by a Prisma `@relation`.
 *
 * Carries enough breadcrumbs (`modelName`, `relationFieldName`) for R09c to
 * cite the source location in error messages. The physical-table fields
 * (`tableName`, `referencedTable`, columns) are what gets compared against
 * `DbForeignKey`.
 */
export interface ExpectedForeignKey {
  /** Owner Prisma model. */
  modelName: string;
  /** Relation field on the owner model (e.g. `org` in `org Org @relation(...)`). */
  relationFieldName: string;
  /** Physical owner table — honors `@@map(...)`. */
  tableName: string;
  /** Physical source columns — honors `@map(...)` on the FK-bearing fields, in declaration order. */
  columns: string[];
  /** Physical referenced table — honors `@@map(...)` on the target model. */
  referencedTable: string;
  /** Physical referenced columns parallel to `columns`. */
  referencedColumns: string[];
  /** Prisma-declared action; defaults to `"no action"` when the keyword is absent. */
  onDelete: ForeignKeyAction;
  /** Prisma-declared action; defaults to `"no action"` when the keyword is absent. */
  onUpdate: ForeignKeyAction;
}

/**
 * Iterate every model × relation field, returning the FKs the Prisma schema
 * implies. Skips back-references and implicit M-N relations.
 */
export function extractExpectedForeignKeys(registry: PrismaModelRegistry): ExpectedForeignKey[] {
  const out: ExpectedForeignKey[] = [];
  for (const model of registry.models.values()) {
    for (const field of model.fields) {
      const target = registry.models.get(field.type);
      if (!target) continue; // not a relation — scalar or unknown enum
      const rel = readRelation(field);
      if (!rel || rel.fields.length === 0 || rel.references.length === 0) continue;

      const sourceColumns = rel.fields.map((fname) => columnNameOnModel(model, fname));
      const referencedColumns = rel.references.map((fname) => columnNameOnModel(target, fname));

      out.push({
        modelName: model.name,
        relationFieldName: field.name,
        tableName: model.tableName,
        columns: sourceColumns,
        referencedTable: target.tableName,
        referencedColumns,
        onDelete: rel.onDelete,
        onUpdate: rel.onUpdate,
      });
    }
  }
  return out;
}

interface RelationParse {
  fields: string[];
  references: string[];
  onDelete: ForeignKeyAction;
  onUpdate: ForeignKeyAction;
}

/**
 * Parse a single field's `@relation(...)` attribute into a normalized shape.
 *
 * Returns `null` when the field has no `@relation` attribute (typical for
 * scalar fields, including the FK-column field itself which is *referenced
 * by* the relation field, not the relation field).
 *
 * Defaults: `onDelete` / `onUpdate` are `"no action"` when not specified —
 * matches Prisma's documented default behavior.
 */
function readRelation(field: FieldInfo): RelationParse | null {
  const attr = field.attributes.find((a) => a.name === "relation");
  if (!attr) return null;

  const fields = readArrayKwarg(attr, "fields");
  const references = readArrayKwarg(attr, "references");
  const onDelete = readActionKwarg(attr, "onDelete");
  const onUpdate = readActionKwarg(attr, "onUpdate");

  return { fields, references, onDelete, onUpdate };
}

function readArrayKwarg(attr: FieldAttribute, key: string): string[] {
  const arg = findKwarg(attr.args, key);
  if (!arg) return [];
  if (arg.kind !== "keyValue") return [];
  if (arg.value.kind !== "array") return [];
  const out: string[] = [];
  for (const v of arg.value.values) {
    const lit = readIdentifierLikeLiteral(v);
    if (lit !== null) out.push(lit);
  }
  return out;
}

function readActionKwarg(attr: FieldAttribute, key: string): ForeignKeyAction {
  const arg = findKwarg(attr.args, key);
  if (!arg || arg.kind !== "keyValue") return "no action";
  // `onDelete: Cascade` — prisma-ast hands us this back as a literal string
  // value (the identifier, not a tagged "function" node), so the easiest read
  // is the literal branch.
  const raw = readIdentifierLikeLiteral(arg.value);
  if (raw === null) return "no action";
  return prismaActionToCanonical(raw);
}

function findKwarg(args: AttributeArg[], key: string): AttributeArg | undefined {
  return args.find((a) => a.kind === "keyValue" && a.key === key);
}

/**
 * Extract a string from places `@mrleebo/prisma-ast` may put bare identifiers:
 * either as a literal string (most common — `onDelete: Cascade` arrives this
 * way) or as a `function` node with empty args (rare, but defensive).
 */
function readIdentifierLikeLiteral(v: AttributeArgValue): string | null {
  if (v.kind === "literal" && typeof v.value === "string") return v.value;
  if (v.kind === "function") return v.name;
  if (v.kind === "identifier") return v.name;
  return null;
}

/**
 * Map Prisma's CamelCase action keywords (`Cascade`, `Restrict`, `NoAction`,
 * `SetNull`, `SetDefault`) onto the SQL-standard lowercase vocabulary used
 * across the rest of the codebase.
 */
export function prismaActionToCanonical(keyword: string): ForeignKeyAction {
  switch (keyword) {
    case "Cascade":
      return "cascade";
    case "Restrict":
      return "restrict";
    case "SetNull":
      return "set null";
    case "SetDefault":
      return "set default";
    default:
      // "NoAction" or anything unknown — bucket conservatively.
      return "no action";
  }
}

function columnNameOnModel(model: ModelInfo, fieldName: string): string {
  const field = model.fields.find((f) => f.name === fieldName);
  if (!field) return fieldName; // best-effort — Prisma should reject this at validate time
  for (const attr of field.attributes) {
    if (attr.name === "map" && attr.args[0]?.kind === "literal") {
      const v = attr.args[0].value;
      if (typeof v === "string") return v;
    }
  }
  return fieldName;
}
