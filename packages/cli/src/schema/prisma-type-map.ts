/**
 * Maps Prisma scalar types (with optional `@db.*` modifiers) to the column
 * type each provider should report.
 *
 * R09b consumes `expectedColumnFor` to predict the shape of a column on the
 * DB side, and `compareTypes` to assert that the actual `DbColumn` matches.
 *
 * Coverage philosophy: best-effort for the common cases (String / Int /
 * BigInt / Boolean / DateTime / Float / Decimal / Bytes / Json) on Postgres
 * and MySQL. SQLite affinities make most comparisons impossible — by design
 * R09b skips on SQLite via `DbCapabilities.typeDriftAccurate = false`, so the
 * SQLite mapping here is informational only (still useful for
 * test-fixture parity).
 *
 * What we deliberately leave as `incomparable`:
 *   - Custom enums and array types (Postgres `text[]`, `int[]`).
 *   - Any Prisma scalar that doesn't have a stable cross-version provider
 *     type — e.g. `Unsupported("...")`.
 *   - When `field.type` isn't a known Prisma scalar (means it's a relation —
 *     callers should filter relations out before invoking).
 *
 * See: packages/checks/rules/R09b-type-drift.md
 */

import type { DbColumn } from "../db/types.js";
import type { FieldInfo } from "./prisma-models.js";

export type SupportedProvider = "postgresql" | "mysql" | "sqlite";

/**
 * What we expect the DB column to look like for a given Prisma field.
 *
 * `dataType` and `udtName` map onto the same fields in `DbColumn` — providers
 * fill them differently (see `db/types.ts`), so the comparator looks at both.
 *
 * `characterMaximumLength`:
 *   - For `String + @db.VarChar(N)` / `@db.Char(N)` we set it to `N` so the
 *     comparator can flag length drift.
 *   - For length-less types it's `null`.
 *
 * `provider` is part of the shape so a comparator never accidentally compares
 * Postgres-flavored expectations to a MySQL `DbColumn`.
 */
export interface ExpectedColumn {
  dataType: string;
  udtName: string;
  characterMaximumLength: number | null;
  provider: SupportedProvider;
}

/**
 * Compute the expected column shape for `field` on `provider`.
 *
 * Returns `null` when:
 *   - `field.type` isn't a recognised Prisma scalar (caller passed a relation
 *     field, or a custom enum which R09b doesn't yet check).
 *   - There's no stable mapping for the requested provider+modifier combo
 *     (e.g. `@db.Citext` on Postgres — we don't enumerate every native type;
 *     R09b returns "incomparable" upstream and skips).
 *
 * The returned shape uses provider-native vocabulary:
 *   - Postgres: `udt_name` lowercase ("varchar", "int4", "int8", "text",
 *     "bool", "timestamp", "timestamptz", "float8", "numeric", "bytea",
 *     "jsonb"). `dataType` carries `information_schema.columns.data_type`
 *     ("character varying", "integer", "bigint", "boolean", ...).
 *   - MySQL: `dataType` and `udtName` both carry `INFORMATION_SCHEMA.COLUMNS.DATA_TYPE`
 *     ("varchar", "int", "bigint", "tinyint", "datetime", "double",
 *     "decimal", "blob", "json").
 *   - SQLite: `dataType` and `udtName` both carry the declared affinity
 *     keyword Prisma generates ("text", "integer", "real", "blob",
 *     "datetime", "decimal").
 */
export function expectedColumnFor(
  field: FieldInfo,
  provider: SupportedProvider,
): ExpectedColumn | null {
  // Array fields skip — Prisma serializes `String[]` as `text[]` on Postgres
  // and not at all on MySQL/SQLite. R09b doesn't support array drift yet.
  if (field.isArray) return null;

  const dbKind = field.dbAttribute?.kind; // e.g. "VarChar", "Text", "SmallInt", "Decimal"
  const dbSize = field.dbAttribute?.size;

  switch (field.type) {
    case "String":
      return stringExpected(dbKind, dbSize, provider);
    case "Int":
      return intExpected(dbKind, provider);
    case "BigInt":
      return bigIntExpected(dbKind, provider);
    case "Boolean":
      return booleanExpected(provider);
    case "DateTime":
      return dateTimeExpected(dbKind, provider);
    case "Float":
      return floatExpected(dbKind, provider);
    case "Decimal":
      return decimalExpected(dbKind, dbSize, provider);
    case "Bytes":
      return bytesExpected(provider);
    case "Json":
      return jsonExpected(provider);
    default:
      return null;
  }
}

/** Comparison verdict for a single column. */
export type TypeComparison = "match" | "drift" | "incomparable";

/**
 * Compare an expected column shape against the actual `DbColumn` reported by
 * the provider.
 *
 * Returns:
 *   - `"match"` when the shapes are equivalent under the provider's
 *     vocabulary (`udtName` equality + length match where applicable).
 *   - `"drift"` when the shapes disagree on `udtName` or
 *     `characterMaximumLength`.
 *   - `"incomparable"` when we can't make a confident decision (e.g. SQLite
 *     declared-text mismatch where we'd produce noise).
 *
 * Comparison rules:
 *   - Postgres / MySQL: compare `udtName` lowercased; if expected has
 *     `characterMaximumLength`, the actual must match (numerically equal).
 *     Length drift counts as `"drift"`.
 *   - SQLite: see file header — most comparisons return `"incomparable"`. We
 *     only accept exact-string matches on declared affinity keywords.
 */
export function compareTypes(expected: ExpectedColumn, actual: DbColumn): TypeComparison {
  const exp = expected.udtName.toLowerCase();
  const got = actual.udtName.toLowerCase();

  if (expected.provider === "sqlite") {
    // SQLite stores whatever was written in CREATE TABLE. We can only assert
    // a match if the declared affinity matches; otherwise assume incomparable
    // rather than emit a false-positive on every column.
    if (exp === got) return "match";
    return "incomparable";
  }

  // Postgres / MySQL: udtName is the primary axis. We fold a few well-known
  // synonyms upfront so the comparator doesn't bounce on cosmetic differences
  // between what Prisma generates and what `information_schema` returns.
  const expSynonym = canonicalize(exp);
  const gotSynonym = canonicalize(got);
  if (expSynonym !== gotSynonym) return "drift";

  // Length: only meaningful when expected pinned a value.
  if (expected.characterMaximumLength !== null) {
    if (actual.characterMaximumLength !== expected.characterMaximumLength) {
      return "drift";
    }
  }

  return "match";
}

/**
 * Fold provider-side synonyms onto a common spelling so the comparator
 * treats them as equivalent. Examples:
 *   - Postgres `character varying` ⇄ `varchar`
 *   - Postgres `integer` ⇄ `int4`
 *   - Postgres `bigint` ⇄ `int8`
 *   - Postgres `boolean` ⇄ `bool`
 *   - Postgres `double precision` ⇄ `float8`
 *   - Postgres `bpchar` ⇄ `character`
 */
function canonicalize(udt: string): string {
  switch (udt) {
    case "character varying":
      return "varchar";
    case "character":
    case "bpchar":
      return "char";
    case "integer":
      return "int4";
    case "smallint":
      return "int2";
    case "bigint":
      return "int8";
    case "boolean":
      return "bool";
    case "double precision":
      return "float8";
    case "real":
      return "float4";
    case "numeric":
      return "decimal";
    case "timestamp without time zone":
      return "timestamp";
    case "timestamp with time zone":
      return "timestamptz";
    default:
      return udt;
  }
}

// ---- per-scalar helpers ----

function stringExpected(
  dbKind: string | undefined,
  dbSize: number | undefined,
  provider: SupportedProvider,
): ExpectedColumn | null {
  if (dbKind === "VarChar") {
    const length = dbSize ?? null;
    if (provider === "postgresql") {
      return {
        dataType: "character varying",
        udtName: "varchar",
        characterMaximumLength: length,
        provider,
      };
    }
    if (provider === "mysql") {
      return { dataType: "varchar", udtName: "varchar", characterMaximumLength: length, provider };
    }
    return { dataType: "text", udtName: "text", characterMaximumLength: null, provider };
  }
  if (dbKind === "Char") {
    const length = dbSize ?? null;
    if (provider === "postgresql") {
      return {
        dataType: "character",
        udtName: "bpchar",
        characterMaximumLength: length,
        provider,
      };
    }
    if (provider === "mysql") {
      return { dataType: "char", udtName: "char", characterMaximumLength: length, provider };
    }
    return { dataType: "text", udtName: "text", characterMaximumLength: null, provider };
  }
  if (dbKind === "Text") {
    if (provider === "postgresql") {
      return { dataType: "text", udtName: "text", characterMaximumLength: null, provider };
    }
    if (provider === "mysql") {
      return { dataType: "text", udtName: "text", characterMaximumLength: null, provider };
    }
    return { dataType: "text", udtName: "text", characterMaximumLength: null, provider };
  }
  // No `@db.*` — Prisma's defaults vary by provider:
  //   - postgres: `text`
  //   - mysql:    `varchar(191)` (Prisma's index-friendly length)
  //   - sqlite:   `text`
  if (provider === "postgresql") {
    return { dataType: "text", udtName: "text", characterMaximumLength: null, provider };
  }
  if (provider === "mysql") {
    return { dataType: "varchar", udtName: "varchar", characterMaximumLength: 191, provider };
  }
  return { dataType: "text", udtName: "text", characterMaximumLength: null, provider };
}

function intExpected(
  dbKind: string | undefined,
  provider: SupportedProvider,
): ExpectedColumn | null {
  if (dbKind === "SmallInt") {
    if (provider === "postgresql") {
      return { dataType: "smallint", udtName: "int2", characterMaximumLength: null, provider };
    }
    if (provider === "mysql") {
      return { dataType: "smallint", udtName: "smallint", characterMaximumLength: null, provider };
    }
    return { dataType: "integer", udtName: "integer", characterMaximumLength: null, provider };
  }
  // Default `Int` mapping.
  if (provider === "postgresql") {
    return { dataType: "integer", udtName: "int4", characterMaximumLength: null, provider };
  }
  if (provider === "mysql") {
    return { dataType: "int", udtName: "int", characterMaximumLength: null, provider };
  }
  return { dataType: "integer", udtName: "integer", characterMaximumLength: null, provider };
}

function bigIntExpected(
  _dbKind: string | undefined,
  provider: SupportedProvider,
): ExpectedColumn | null {
  if (provider === "postgresql") {
    return { dataType: "bigint", udtName: "int8", characterMaximumLength: null, provider };
  }
  if (provider === "mysql") {
    return { dataType: "bigint", udtName: "bigint", characterMaximumLength: null, provider };
  }
  return { dataType: "integer", udtName: "integer", characterMaximumLength: null, provider };
}

function booleanExpected(provider: SupportedProvider): ExpectedColumn {
  if (provider === "postgresql") {
    return { dataType: "boolean", udtName: "bool", characterMaximumLength: null, provider };
  }
  if (provider === "mysql") {
    // Prisma maps Boolean → tinyint(1). We compare against `tinyint`.
    return { dataType: "tinyint", udtName: "tinyint", characterMaximumLength: null, provider };
  }
  return { dataType: "integer", udtName: "integer", characterMaximumLength: null, provider };
}

function dateTimeExpected(dbKind: string | undefined, provider: SupportedProvider): ExpectedColumn {
  // Prisma `DateTime` defaults differ:
  //   - postgres: `timestamp` (without time zone) — but the docs note
  //     `@db.Timestamptz` is also legitimate. We accept the default.
  //   - mysql:    `datetime(3)` (with millisecond precision).
  //   - sqlite:   text/numeric — incomparable.
  if (dbKind === "Timestamptz") {
    return {
      dataType: "timestamp with time zone",
      udtName: "timestamptz",
      characterMaximumLength: null,
      provider,
    };
  }
  if (provider === "postgresql") {
    return {
      dataType: "timestamp without time zone",
      udtName: "timestamp",
      characterMaximumLength: null,
      provider,
    };
  }
  if (provider === "mysql") {
    return { dataType: "datetime", udtName: "datetime", characterMaximumLength: null, provider };
  }
  return { dataType: "datetime", udtName: "datetime", characterMaximumLength: null, provider };
}

function floatExpected(_dbKind: string | undefined, provider: SupportedProvider): ExpectedColumn {
  if (provider === "postgresql") {
    return {
      dataType: "double precision",
      udtName: "float8",
      characterMaximumLength: null,
      provider,
    };
  }
  if (provider === "mysql") {
    return { dataType: "double", udtName: "double", characterMaximumLength: null, provider };
  }
  return { dataType: "real", udtName: "real", characterMaximumLength: null, provider };
}

function decimalExpected(
  _dbKind: string | undefined,
  _dbSize: number | undefined,
  provider: SupportedProvider,
): ExpectedColumn {
  // Prisma `Decimal` defaults to `decimal(65,30)` on Postgres/MySQL — we don't
  // (yet) compare precision/scale because they're not reported in the same
  // `characterMaximumLength` slot; that level of drift is out of scope for
  // R09b v1 and tracked as a follow-up. Match on type name only.
  if (provider === "postgresql") {
    return { dataType: "numeric", udtName: "numeric", characterMaximumLength: null, provider };
  }
  if (provider === "mysql") {
    return { dataType: "decimal", udtName: "decimal", characterMaximumLength: null, provider };
  }
  return { dataType: "decimal", udtName: "decimal", characterMaximumLength: null, provider };
}

function bytesExpected(provider: SupportedProvider): ExpectedColumn {
  if (provider === "postgresql") {
    return { dataType: "bytea", udtName: "bytea", characterMaximumLength: null, provider };
  }
  if (provider === "mysql") {
    return { dataType: "longblob", udtName: "longblob", characterMaximumLength: null, provider };
  }
  return { dataType: "blob", udtName: "blob", characterMaximumLength: null, provider };
}

function jsonExpected(provider: SupportedProvider): ExpectedColumn {
  if (provider === "postgresql") {
    return { dataType: "jsonb", udtName: "jsonb", characterMaximumLength: null, provider };
  }
  if (provider === "mysql") {
    return { dataType: "json", udtName: "json", characterMaximumLength: null, provider };
  }
  return { dataType: "text", udtName: "text", characterMaximumLength: null, provider };
}
