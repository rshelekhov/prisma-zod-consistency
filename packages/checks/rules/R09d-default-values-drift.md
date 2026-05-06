# R09d — Default-value drift vs live DB

| Field | Value |
|---|---|
| Severity (default) | warning |
| Phase | post-MVP |
| Surface | CLI (`--db`) + skill |
| Group | B (live DB) |
| Auto-fix | no — default drift implies a migration decision |
| Implementation | done (Postgres + MySQL + SQLite) |

## What it checks

Compares the field-level `@default(...)` Prisma declares against the raw `column_default` the database reports. Both sides are normalized first, so cosmetic differences (Postgres `::text` casts, `42.0` vs `42`, `now()` vs `CURRENT_TIMESTAMP`) don't produce false positives.

Three classes of finding:

1. **Drift on a concrete default** — `Prisma says 'draft', DB says 'pending'`. The most useful kind.
2. **Prisma says a default, DB has none** — usually a missed migration.
3. **DB has a default, Prisma doesn't declare one** — usually a manual `ALTER COLUMN SET DEFAULT` that wasn't mirrored back into `schema.prisma`.

## Why it matters

Default drift is silent on every existing row (the value at insert time is what was current then) — but **changes the behavior on every new insert**. A column that used to default to `'draft'` and now defaults to `'pending'` will silently start writing the new value, breaking downstream consumers that assumed `'draft'`.

It also causes `prisma migrate dev` against a drifted DB to produce surprising "fix" migrations, depending on which side is canonical.

## How to fix

- **Prisma is canonical.** Run a migration that sets the DB default to match (`ALTER COLUMN status SET DEFAULT 'draft'`).
- **DB is canonical.** Update `@default(...)` in `schema.prisma` to match.

No auto-fix. Like the rest of the R09 family, every drift implies a deliberate decision about the source of truth.

## Examples

### Bad — concrete drift

```
Default-value drift on `Post.status`: Prisma says 'draft', DB says 'pending'.
```

### Bad — Prisma declares default, DB has none

```
Default-value drift on `Post.priority`: Prisma says 0, DB says <no default>.
```

### Good — defaults align after normalization

`@default("draft")` ↔ `'draft'::text` (Postgres cast stripped) → no finding.
`@default(now())` ↔ `CURRENT_TIMESTAMP` (clock family folded) → no finding.
`@default(42)` ↔ `42` or `42::int4` or `42.0` (numeric equality) → no finding.

### Skipped — generated / non-deterministic defaults

These intentionally don't compare:

- Prisma `@default(cuid())` / `@default(uuid())` / `@default(autoincrement())` — client-side or DB-sequence-driven.
- Prisma `@default(dbgenerated("..."))` — passthrough, not Prisma-side comparable.
- DB `nextval(...)`, `gen_random_uuid()`, `uuid_generate_v4()` — generator output.

When *either side* is in skip-list territory, R09d emits no finding. This avoids steady noise on every autoincrement column where the DB will (correctly) report `nextval(...)` while Prisma reports `autoincrement()`.

## Configuration

```jsonc
{
  "R09d": {
    "severity": "warning",
    "ignoreTables": ["_prisma_migrations"],
    "ignoreColumns": ["^created_at$", "^updated_at$"]
  }
}
```

`ignoreColumns` is a list of regex patterns matched against `column_name` (not `table.column`). Common use: silencing timestamp columns whose defaults are managed by triggers rather than declared in Prisma.

## Common false positives

- **Casts the rule doesn't strip.** R09d strips one Postgres `::type` cast suffix; chained casts (`'foo'::text::varchar`) won't fully normalize. Rare in practice. If you hit one, file an issue or `ignoreColumns` it.
- **Function-call defaults outside the well-known set.** A custom Postgres function call (e.g. `compute_default()`) lands in the `raw` bucket and is compared by string equality. If Prisma's side and DB's side spelled it differently, R09d will report drift. Use `ignoreColumns` for known cases, or wrap the column with `@default(dbgenerated("..."))` on the Prisma side which forces a skip.
- **Trigger-managed defaults.** Some teams manage `created_at` / `updated_at` via DB triggers rather than `DEFAULT now()`; the column reports `<no default>` even though every insert gets a timestamp. Add to `ignoreColumns`.

## Provider support

| Provider   | Source of `column_default`            | Notes                                                                                                                            |
|------------|---------------------------------------|----------------------------------------------------------------------------------------------------------------------------------|
| postgresql | `information_schema.columns.column_default` | Casts (`'draft'::text`, `42::int4`, `now()::timestamp`) stripped before comparison. `nextval(...)` / `gen_random_uuid()` skipped. |
| mysql      | `INFORMATION_SCHEMA.COLUMNS.COLUMN_DEFAULT` | Literal text without casts. `CURRENT_TIMESTAMP[(N)]` folded onto `now`.                                                          |
| sqlite     | `PRAGMA table_info(...).dflt_value`         | Raw expression as written in `CREATE TABLE`, including outer single quotes for strings. `CURRENT_TIMESTAMP` folded onto `now`.   |

## Implementation notes

- **Normalizer.** Lives in `packages/cli/src/schema/default-normalize.ts`. Two entry points:
  - `normalizePrismaDefault(field)` reads the field's `@default(...)` attribute and returns a `NormalizedDefault` discriminated union.
  - `normalizeDbDefault(raw)` does the same for a raw provider-side string.
  - `defaultsEqual(a, b)` returns the verdict.
- **Skip-list.** Both sides have skip-lists; `defaultsEqual` returns `true` whenever either side is `{ kind: "skip" }`. This is intentional — drift on generated defaults isn't actionable.
- **Numeric equality.** Numbers compare via JavaScript `===` after `Number.parseFloat`, so `42` ↔ `42.0` ↔ `42::int4` all match.
- **Boolean folding.** `true` / `'t'` / `'true'` all canonicalize to boolean-true; same for false. Avoids friction with Postgres' historical char-quoted boolean form.
- **Future tightening.** Variant B (`pg-query-emscripten` AST normalization) is not used because the dependency footprint dwarfs the rule's value. If this rule develops a steady false-positive backlog, Variant B becomes worth the cost.

## See also

- R09 — Schema drift (column existence + nullability)
- R09b — Type drift
- R09c — FK constraints drift
