---
"prisma-zod-consistency": minor
---

Group B (live-DB) rules now support **MySQL/MariaDB** and **SQLite** in addition to PostgreSQL.

## What's new

- **MySQL adapter** (`mysql2`) — R07/R08/R09 work against any MySQL 5.7+ / MariaDB 10.0+ instance. Index metadata comes from `INFORMATION_SCHEMA.STATISTICS`; index-usage statistics for R08 from `performance_schema.table_io_waits_summary_by_index_usage` (default-on in 5.7+; if disabled, R08 silently skips with a stderr warning).
- **SQLite adapter** (`better-sqlite3`) — R07 (redundant indexes) and R09 (schema drift) work against any SQLite database. R08 (unused indexes) is silently skipped because SQLite does not track per-index read counts; the runner emits one stderr warning when R08 is explicitly requested on SQLite.
- **Provider dispatch** — `runner.ts` no longer hard-gates on `provider === "postgresql"`. Group B rules now run for `postgresql / mysql / sqlite`. Other providers (`sqlserver`, `mongodb`, `cockroachdb`) get a clear error with no attempt to introspect.
- **Capability flag** — `DbSnapshot` gains `capabilities: { indexUsageTracking: boolean }`, consumed by R08 to decide whether to run.
- **R07/R08/R09 specs** updated with a per-provider matrix documenting what each adapter sees and the semantic differences (especially for R08 on MySQL vs Postgres).

## Breaking change — database drivers are now optional peer dependencies

Previously `postgres` was a runtime dependency of the CLI. Now `postgres`, `mysql2`, and `better-sqlite3` are all **optional peer dependencies**. Install only the driver for the provider you actually use:

```bash
# PostgreSQL projects:
pnpm add -D postgres

# MySQL/MariaDB projects:
pnpm add -D mysql2

# SQLite projects:
pnpm add -D better-sqlite3
```

If you only use the static rules (R01–R05) you don't need any of these. Running `--db` without the matching driver fails with an actionable error message that names the install command.

This shift keeps the install lightweight (no native SQLite binary for users who don't touch SQLite, no second SQL driver pulled in) and is consistent with how other multi-DB libraries in the ecosystem handle drivers (e.g. drizzle-orm, kysely). Pre-1.0 was the right window for the change.
