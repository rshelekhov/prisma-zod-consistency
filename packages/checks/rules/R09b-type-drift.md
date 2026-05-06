# R09b — Type drift vs live DB

| Field | Value |
|---|---|
| Severity (default) | warning |
| Phase | post-MVP |
| Surface | CLI (`--db`) + skill |
| Group | B (live DB) |
| Auto-fix | no — type drift implies a migration decision |
| Implementation | done (Postgres + MySQL); skipped on SQLite |

## What it checks

Compares the Prisma field's declared type (with `@db.*` modifiers) against the actual column type the database reports. Catches drift cases that R09 (column existence + nullability) doesn't address:

- `String @db.VarChar(100)` in `schema.prisma` vs `varchar(255)` in DB
- `Int` in Prisma vs `bigint` in DB (or vice versa)
- `String` (no `@db.*`) on Postgres → expects `text`, but DB has `varchar(...)`
- `DateTime` vs `DateTime @db.Timestamptz` mismatches

## Why it matters

Type drift is silent at the Prisma level — the client happily reads/writes the column regardless of the underlying type. The damage shows up later:

- **Truncation.** Writing a 200-char string into a `varchar(100)` column truncates without error on some legacy MySQL configs, or hard-fails in production at insert time on Postgres.
- **Range overflow.** Prisma `Int` reads from a `bigint` column work, but writing a value that wouldn't fit in `int4` will fail at the DB level — months after the schema diverged.
- **Time-zone surprises.** `timestamp` vs `timestamptz` on Postgres changes how dates are stored and retrieved; a drift here corrupts every timestamp on read in a tz-aware app.
- **Migration regeneration.** `prisma migrate dev` against a drifted DB produces a "fix" migration that may rewrite the column the wrong direction, depending on which side is the source of truth.

## How to fix

Decide which side is canonical:

- **Prisma is canonical.** Write a migration to ALTER the column to match Prisma:
  ```sql
  ALTER TABLE "User" ALTER COLUMN "email" TYPE varchar(100);
  ```
- **DB is canonical.** Update `schema.prisma` to match what the DB has:
  ```prisma
  email String @db.VarChar(255)
  ```

No auto-fix. Like R09, every drift implies a deliberate decision about the source of truth.

## Examples

### Bad — length drift

```
Type drift on `User.email`: Prisma says String @db.VarChar(100), DB says varchar(255).
```

### Bad — type drift

```
Type drift on `Stat.count`: Prisma says Int, DB says int8.
```

### Good — shapes align

`String @db.VarChar(100)` ↔ `varchar(100)`. No finding.

### Ambiguous — flagged but possibly intentional

- **Length expansion that hasn't been mirrored back to Prisma.** A DBA bumped `varchar(100) → varchar(255)` for a customer field but the Prisma update is still in review.
- **Same-class numeric promotion.** `Int → bigint` because rows are growing past int4. Real fix is to update Prisma to `BigInt`.

## Configuration

```jsonc
{
  "R09b": {
    "severity": "warning",
    "ignoreTables": ["_prisma_migrations", "audit_view"],
    "ignoreColumns": ["^legacy_"]   // regex, applied to any table
  }
}
```

`ignoreColumns` is a list of regex patterns matched against `column_name` (not `table.column`). A pattern like `^legacy_` skips anything starting with `legacy_`.

There is **no `skipOnSqlite` config flag** — the SQLite skip is driven by `DbCapabilities.typeDriftAccurate = false`, which the SQLite adapter sets automatically (see "Provider support" below). If you want R09b on SQLite for some reason, the path is to extend the adapter.

## Common false positives

- **Prisma defaults that don't match older DB defaults.** Prisma changed `String` mapping on MySQL from `mediumtext` to `varchar(191)` historically; pre-existing tables still have `mediumtext`. Treat this as real drift and migrate, or `ignoreColumns` it.
- **`@db.Timestamptz` vs `@db.Timestamp`.** Both are legitimate; if your app explicitly chose one but the DB has the other, that's actual drift. The rule will surface it; pick a side.
- **Custom `@db.*` modifiers we don't yet model.** R09b silently skips fields with unrecognised modifiers (returns `null` from `expectedColumnFor`) instead of producing noisy false positives. Add coverage in `prisma-type-map.ts` if you need a specific modifier checked.

## Provider support

| Provider   | Source of column metadata               | Notes                                                                                                                                |
|------------|-----------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------|
| postgresql | `information_schema.columns.udt_name` + `character_maximum_length` | Full feature support. Synonyms (`character varying` ↔ `varchar`, `integer` ↔ `int4`, `boolean` ↔ `bool`, `double precision` ↔ `float8`, `numeric` ↔ `decimal`, `timestamp without time zone` ↔ `timestamp`, etc.) folded into a canonical form before comparison.                                                                  |
| mysql      | `INFORMATION_SCHEMA.COLUMNS.DATA_TYPE` + `character_maximum_length` | Full type + length comparison. Boolean → tinyint mapping built in. `int unsigned` is currently outside the comparator (Prisma rarely uses unsigned).                                                                                                            |
| sqlite     | Skipped — `DbCapabilities.typeDriftAccurate = false`               | SQLite stores type affinities, not enforced declared types. `VARCHAR(100)` and `varchar(255)` are indistinguishable at the metadata level. R09b silently returns `[]`. The runner emits a one-shot stderr warning when R09b is explicitly listed via `--rules R09b` on a SQLite project. |

## Implementation notes

- **Mapping module.** `packages/cli/src/schema/prisma-type-map.ts` has `expectedColumnFor(field, provider)` and `compareTypes(expected, actual)`. The map is intentionally small and explicit — covering ~15 most common Prisma scalar × `@db.*` × provider combinations. Adding a new modifier means adding a case to one helper; tests in `r09b.test.ts` enforce per-provider expectations.
- **Capability gate.** Like R08/`indexUsageTracking`, R09b reads `DbCapabilities.typeDriftAccurate` and silently returns `[]` when it's `false`. The runner emits a one-shot stderr warning on SQLite when R09b is explicitly requested.
- **Length comparison.** Length is only checked when the *expected* shape pins a length (`@db.VarChar(N)` / `@db.Char(N)`). Without a Prisma-side length, any DB length is accepted — that case is a "missing modifier on the Prisma side" decision, not type drift, and outside R09b's scope.
- **Decimal precision / scale.** Currently R09b matches by type name only (`numeric` / `decimal`); precision/scale comparison would require an additional metadata field that providers expose differently. Tracked as a follow-up.
- **Relation fields and array fields are skipped** — those have no scalar mapping. Custom enums are also skipped (we'd need a separate enum-presence check).

## See also

- R09 — Schema drift (column existence + nullability; same data, different signal)
- R09c — FK constraints drift
- R09d — Default values drift
- R04 — Nullability mismatch (static, Prisma ↔ Zod side)
