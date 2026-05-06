# R09 — Schema drift vs live DB

| Field | Value |
|---|---|
| Severity (default) | warning |
| Phase | 1.5 |
| Surface | CLI (`--db`) + skill |
| Group | B (live DB) |
| Auto-fix | no — drift always implies a migration decision |
| Implementation | done (column-level for Postgres + MySQL + SQLite). Type / FK / default drift are split into [R09b](R09b-type-drift.md) / [R09c](R09c-fk-constraints-drift.md) / [R09d](R09d-default-values-drift.md). |

## What it checks

Compares the parsed `schema.prisma` model registry against the actual database via `information_schema.columns`. Catches cases that `prisma migrate diff` misses — manual SQL migrations, columns added by other services to a shared DB, columns left behind after a Prisma model removal.

Three classes of finding:

1. **Model in Prisma but not in DB** — table doesn't exist. Likely a pending migration not yet run on this database.
2. **Column in Prisma but not in DB** — same as above but at column granularity (the table exists, the column doesn't).
3. **Column in DB but not in Prisma** — orphan column. Either an old field someone forgot to drop, or a field added by another system (a worker, an external service writing into the same DB).
4. **Nullability mismatch** — Prisma says required (`String`), DB says nullable (or vice versa). Excluded for array fields — see Common false positives.

Type drift (e.g. `@db.VarChar(100)` in Prisma vs `varchar(255)` in DB) is covered by **[R09b](R09b-type-drift.md)**. FK constraint drift (`@relation(... onDelete: Cascade)` vs DB) is **[R09c](R09c-fk-constraints-drift.md)**. Default-value drift (`@default("draft")` vs DB DEFAULT) is **[R09d](R09d-default-values-drift.md)**.

Resolves table names through `@@map(...)`; falls back to the model name as written (which is Prisma's actual default — Prisma does NOT auto-snake_case unless you tell it to). Field names go through `@map(...)`.

## Why it matters

Drift between the codebase's mental model of the schema and the actual schema causes:

- **Silent runtime errors** when reading columns that don't exist (null on every row) or not reading columns that do exist (data loss in DTOs, security info leaks).
- **Migration headaches** — a `prisma migrate dev` against a drifted DB regenerates a migration that "fixes" the drift, possibly clobbering the manually-added columns or rewriting a hand-tuned schema.
- **Cross-team coordination failures** when multiple services share a DB and only one team owns the Prisma schema.

## How to fix

Depends on the class:

- **Pending migration** — `pnpm prisma migrate deploy` (CI/prod) or `pnpm prisma migrate dev` (local).
- **Orphan column in DB** — either remove from DB if truly unused, or add to `schema.prisma` to bring under Prisma's management.
- **Nullability mismatch** — write a migration to ALTER the column to match Prisma, or update Prisma to match the actual DB if the DB is the source of truth.

No auto-fix. Every R09 finding implies a deliberate decision about the source of truth.

## Examples

### Bad — pending migration

```
Model `EmailThreadAnchor` (table `email_thread_anchors`) is declared in
schema.prisma but does not exist in the database.
```

The model was added in `schema.prisma`, the migration was generated, but `prisma migrate deploy` never ran on this database.

### Bad — orphan column

```
Column `users.legacy_external_id` exists in the database but is not declared
in schema.prisma.
```

A column from a deprecated integration. Either drop it (if truly unused) or add it to the User model (if some external process still writes to it).

### Bad — nullability drift

```
Nullability drift on `User.email`: Prisma says required, DB says nullable.
```

Likely a hand-written migration relaxed the column to nullable, but `schema.prisma` wasn't updated. Reads of users with `email = NULL` will fail to parse against `userSchema.email = z.string()`.

### Ambiguous — flagged but often expected

- **External services writing to shared columns** that aren't in your Prisma schema by design. Add to `R09.ignoreColumns` once confirmed.
- **Prisma internal tables** (`_prisma_migrations`) — auto-excluded.
- **Views and materialized views** — currently surface as orphan tables (Prisma doesn't model them). Configure `R09.ignoreTables` for them.

## Configuration

```jsonc
{
  "R09": {
    "severity": "warning",
    "ignoreTables": ["_prisma_migrations", "audit_view"],
    "ignoreColumns": ["^legacy_", "_internal$"]    // regex, applied to any table
  }
}
```

`ignoreColumns` is a list of regex patterns matched against `column_name` (not `table.column`). A pattern like `^legacy_` skips anything starting with `legacy_`.

## Common false positives

- **Array nullability.** Prisma `String[]` (required) compiles to a Postgres `text[]` column that is nullable at the SQL level. The Prisma client hides this on read. The rule **already skips arrays** for the nullability check, but if you see one, file an issue.
- **Pending migration that you intend to run later.** The "model declared but missing in DB" finding is correct but expected — run the migration. Not really a false positive, just an actionable signal.
- **Views and matviews** — see Ambiguous.
- **Other-schema tables.** The introspection defaults to `public`. Tables in other schemas (e.g. `audit.events`) are invisible. If you have multi-schema, configure `R09.schema` (planned).

## Provider support

| Provider   | Source of column metadata               | Notes                                                                                                                                |
|------------|-----------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------|
| postgresql | `information_schema.columns`            | Full feature support. Default schema `public`; override planned via `R09.schema`.                                                     |
| mysql      | `INFORMATION_SCHEMA.COLUMNS`            | Full column / nullability comparison. The MySQL adapter pulls `DATA_TYPE` (mapped into both `dataType` and `udtName` for symmetry).   |
| sqlite     | `PRAGMA table_info(...)`                | No declared length is enforced; `characterMaximumLength` is always `null` on SQLite, which limits R09b (type drift, planned) but does not affect R09 v1's column-existence and nullability checks. |

## Implementation notes

- **Column-level only.** Type drift (e.g. `varchar(100)` ↔ `varchar(255)`, `int4` ↔ `int8`, `text` ↔ `varchar`) lives in [R09b](R09b-type-drift.md). `Bytes` and similarly exotic types are best-effort there, not exhaustive.
- **Default values.** Compared by [R09d](R09d-default-values-drift.md). A column that defaults to `'pending'` in DB but `@default("draft")` in Prisma will surface there.
- **Indexes and constraints** are not part of R09 — those live in R07/R08 (indexes) and [R09c](R09c-fk-constraints-drift.md) (FK constraint drift).
- **Honors `@@map(...)` and `@map(...)`** for table and column names respectively.
- **Strips quotes from string-literal attribute args.** Earlier versions had a bug where `@map("col")` came through as `"col"` (with quotes), causing 100% false positives on every `@map`-using field. Fixed; regression test in `tests/prisma-models.test.ts`.

## See also

- [R09b](R09b-type-drift.md) — Type drift (column type / length)
- [R09c](R09c-fk-constraints-drift.md) — Foreign-key constraints drift
- [R09d](R09d-default-values-drift.md) — Default-value drift
- R07 — Redundant indexes (live DB, different signal)
- R08 — Unused indexes (live DB, different signal)
- R04 — Nullability mismatch (static, Prisma ↔ Zod side; R09 does the Prisma ↔ DB side)
