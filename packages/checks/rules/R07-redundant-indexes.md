# R07 — Redundant indexes

| Field | Value |
|---|---|
| Severity (default) | info |
| Phase | 1.5 |
| Surface | CLI (`--db`) + skill |
| Group | B (live DB) |
| Auto-fix | no — Prisma migrations are user-controlled |
| Implementation | done (Postgres + MySQL + SQLite) |

## What it checks

Detects pairs of indexes on the same table where one's leading column list is a strict prefix of another's. The narrower index is redundant — Postgres uses the wider one for any query that the narrower one would have served.

Excluded automatically:

- **Primary keys.** A table's PK is always present and isn't a discretionary index.
- **Partial indexes** (with `WHERE` clauses). Different filter scope, not interchangeable.
- **Unique narrow + non-unique wide.** The narrow uniqueness is a constraint, not just an access path; can't drop it without losing the uniqueness guarantee.

## Why it matters

Every redundant index has a real cost:

- **Write overhead.** Every `INSERT`, `UPDATE`, and `DELETE` updates every index on the affected rows. Two indexes on the same column = double the write cost for nothing.
- **Disk space and bloat.** Index bloat compounds with table churn.
- **Vacuum/autovacuum cost.** More indexes = more work for autovacuum.

For high-write tables (audit logs, conversation messages, payment events) the difference is measurable.

## How to fix

Remove the redundant `@@index([...])` from `schema.prisma` and run a migration:

```bash
# 1. Edit schema.prisma — delete the redundant @@index line
# 2. Generate the migration:
pnpm prisma migrate dev --name drop_redundant_index_<table>
# Prisma writes:
#   DROP INDEX "<schema>"."<index_name>";
```

Before applying, double-check nothing relies on the index by name in raw SQL or `pg_hint_plan` directives.

No auto-fix: the rule lives in the live-DB layer, the fix lives in `schema.prisma` (which the auto-fix subsystem deliberately never touches), and the migration must be a deliberate developer action.

## Examples

### Bad

```prisma
model CommunicationRead {
  communicationId String
  userId          String

  @@unique([communicationId, userId])
  @@index([communicationId])     // redundant — covered by the unique above
}
```

### Good

```prisma
model CommunicationRead {
  communicationId String
  userId          String

  @@unique([communicationId, userId])
  // No separate @@index([communicationId]) — the unique covers it.
}
```

### Ambiguous — flagged but might be intentional

- **Index hints in raw SQL.** If somewhere in your codebase there's raw SQL with an explicit index hint by name (`SET enable_indexscan = false; ... USING <name>`), dropping the index breaks that query. Rare in Prisma codebases.
- **Different access patterns at different times.** Composite `(a, b)` is great for `WHERE a = ? AND b = ?`. The narrow `(a)` is technically usable but identical performance for `WHERE a = ?`. Almost never legitimate to keep both.

## Configuration

```jsonc
{
  "R07": {
    "severity": "info",
    "ignoreTables": ["_prisma_migrations"]   // common Prisma internal table
  }
}
```

## Common false positives

- **None observed in practice.** R07 is one of the highest-precision rules in the suite — the prefix relationship is mechanical and the exclusions handle the corner cases (partial, unique-vs-non-unique). Smoke run on llc_backoffice produced 2 findings, both real.
- **One theoretical case:** if the wider index is `INCLUDE (...)` (Postgres covering index with payload columns), the narrower index has different scan characteristics. R07 currently doesn't read `INCLUDE` columns, so a narrow `(a)` next to a wide `(a, b) INCLUDE (c)` would still be flagged. In practice covering indexes are rare in Prisma codebases.

## Provider support

| Provider   | Source of index metadata                                  | Notes                                                                                                               |
|------------|-----------------------------------------------------------|---------------------------------------------------------------------------------------------------------------------|
| postgresql | `pg_index` + `pg_get_indexdef` (parses ordered column list) | Full feature support, including `is_partial` exclusion.                                                              |
| mysql      | `INFORMATION_SCHEMA.STATISTICS` grouped by `(table, index)` ordered by `SEQ_IN_INDEX` | No partial-index concept in MySQL — `isPartial` is always `false`. Functional/expression entries are skipped.       |
| sqlite     | `PRAGMA index_list(...)` + `PRAGMA index_info(...)`        | PK on `rowid` (the default for `INTEGER PRIMARY KEY`) is not surfaced by SQLite — R07 doesn't see it, which is fine because R07 never flags PKs anyway. Expression-column entries are dropped. |

The driver behind each adapter is an optional peer dependency: install `postgres` / `mysql2` / `better-sqlite3` only for the engine your project uses.

## Implementation notes

- **Excludes `_prisma_migrations` table** by default on every provider (the table itself, not just indexes).
- **Schema.** Postgres defaults to `public`; MySQL pulls the database name from `DATABASE_URL`; SQLite has only one logical schema (`main`).
- **Type drift, NULL semantics, length:** out of scope for R07 — see R09 / R09b.

## See also

- R08 — Unused indexes (different signal: idx might be non-redundant but never scanned)
- R06 — Missing index (skill-only, the inverse problem: a query that needs an index)
