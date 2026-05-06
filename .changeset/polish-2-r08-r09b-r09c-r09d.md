---
"prisma-zod-consistency": minor
---

Polish #2 — three new live-DB rules and an R08 false-positive fix.

## What's new

- **R09b — type drift vs live DB.** Compares the Prisma field type (with `@db.*` modifiers) against the actual column type the database reports. Catches `@db.VarChar(100)` ↔ `varchar(255)`, `Int` ↔ `bigint`, `text` ↔ `varchar`, and similar mismatches that R09 (column existence + nullability) doesn't address. Postgres + MySQL fully covered. SQLite silently skipped via the new `DbCapabilities.typeDriftAccurate = false` capability flag — affinity-based typing makes the comparison unreliable; the runner emits a one-shot stderr warning when R09b is explicitly requested on SQLite.

- **R09c — foreign-key constraints drift vs live DB.** Compares Prisma `@relation(fields:..., references:..., onDelete:..., onUpdate:...)` against the constraints reported by the database. Three classes of finding: missing FK in DB, orphan FK in DB, and action drift (`onDelete: Cascade` in Prisma vs `NO ACTION` in DB). Honors `@map(...)` and `@@map(...)`. Multi-column FKs supported. Postgres + MySQL + SQLite all covered.

- **R09d — default-value drift vs live DB.** Compares Prisma `@default(...)` against the column DEFAULT reported by the database, with normalization for Postgres `::type` casts, numeric forms (`42` ↔ `42.0`), boolean spellings (`true` ↔ `'t'` ↔ `1`), and the clock-default family (`now()` ↔ `CURRENT_TIMESTAMP` ↔ `current_timestamp(3)`). Generated defaults — `cuid()` / `uuid()` / `autoincrement()` / `dbgenerated(...)` on the Prisma side and `nextval(...)` / `gen_random_uuid()` on the DB side — are intentionally skipped. Postgres + MySQL + SQLite all covered.

- **R08: exclude unique non-PK indexes by default (B4).** Postgres / MySQL bump `idx_scan` / `count_read` only on read-path lookups; a unique index used purely for constraint enforcement on inserts/updates therefore looks "unused" by this metric, producing steady noise on every Prisma `@unique` column. The rule now skips them by default. Re-enable via `R08.includeUnique = true` for one-off audits.

## DbSnapshot extensions

- `DbColumn.columnDefault: string | null` — raw DEFAULT expression as the provider reports it (Postgres / MySQL / SQLite all populate).
- `DbSnapshot.foreignKeys: DbForeignKey[]` — normalized FK list, including parallel `columns` / `referencedColumns` arrays for multi-column FKs and a `ForeignKeyAction` discriminated vocabulary (`cascade` / `restrict` / `no action` / `set null` / `set default`).
- `DbCapabilities.typeDriftAccurate: boolean` — `true` for Postgres/MySQL, `false` for SQLite. Drives R09b silent-skip the same way `indexUsageTracking` drives R08.

These are additive shape changes — existing consumers get the new fields populated automatically and can ignore them.

## Configuration

```jsonc
{
  "rules": {
    "R08":  { "includeUnique": false },                          // new flag
    "R09b": { "ignoreTables": [], "ignoreColumns": [] },         // new rule
    "R09c": { "ignoreTables": [], "ignoreRelations": [] },       // new rule
    "R09d": { "ignoreTables": [], "ignoreColumns": [] }          // new rule
  }
}
```

`ignoreRelations` on R09c is matched against `Model.field` (e.g. `Membership.org`); the others use `column_name`. Full per-rule docs in `packages/checks/rules/R09{b,c,d}-*.md`.
