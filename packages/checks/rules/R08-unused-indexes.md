# R08 — Unused indexes

| Field | Value |
|---|---|
| Severity (default) | info |
| Phase | 1.5 |
| Surface | CLI (`--db`) + skill |
| Group | B (live DB) |
| Auto-fix | no |
| Implementation | done (Postgres + MySQL); skipped on SQLite |

## What it checks

An index is reported as "unused" when:

1. `pg_stat_user_indexes.idx_scan = 0` for that index, AND
2. The parent table has done meaningful sequential-scan work (`pg_stat_user_tables.seq_scan > 0`) — i.e. the table is alive, just not using this particular index, AND
3. The table has at least `minRowCount` rows (default 1000) — Postgres legitimately picks `seq_scan` over an index on tiny tables, so unused indexes there are not necessarily wasteful.

Primary keys are excluded automatically.

## Why it matters

An index that's never used costs writes (every `INSERT`/`UPDATE`/`DELETE` updates it) and disk space, with zero read benefit. The signal is unambiguous when the conditions above are met: the access pattern this index was created for either no longer exists or was never realized.

## How to fix

```bash
# 1. Verify with EXPLAIN that no current query plan benefits from the index.
# 2. Edit schema.prisma — delete the @@index line.
# 3. Generate migration:
pnpm prisma migrate dev --name drop_unused_<table>_<column>_index
```

Optional safety net: drop it `CONCURRENTLY` first, monitor for a week, then commit the schema.prisma change.

## Examples

### Bad — index never used

```
pg_stat_user_indexes:
  contacts.contacts_legacy_zip_idx: idx_scan = 0

pg_stat_user_tables:
  contacts: seq_scan = 4_532, n_live_tup = 50_000
```

The table is being scanned (so it's not dormant), but `contacts_legacy_zip_idx` was never picked. Likely a leftover from a removed feature.

### Good — index actively used

```
pg_stat_user_indexes:
  contacts.contacts_email_idx: idx_scan = 12_847_293
```

### Ambiguous — flagged but possibly intentional

- **Index used only by reports/cron jobs that haven't run yet.** A monthly aggregation job might use an index. If your stats window is a week and the job hasn't fired, the index looks unused.
- **Index serving a planned (not-yet-launched) feature.** If you pre-deployed the schema for an upcoming release, the index has 0 scans by design.
- **Read replicas.** `pg_stat_user_indexes` on the primary doesn't see scans on replicas. If reads route to replicas, indexes can look unused on the primary.

## Configuration

```jsonc
{
  "R08": {
    "severity": "info",
    "minRowCount": 1000,
    "ignoreIndexes": ["_pkey$", "^contacts_legacy_"]   // regex patterns
  }
}
```

`ignoreIndexes` is regex-tested against the index name. Useful for grandfathered indexes you've decided to keep despite the signal.

## Common false positives

- **Recently restarted Postgres.** `pg_stat_user_indexes.idx_scan` resets to 0 on restart and accumulates from there. If your DB was restarted hours/days ago, R08 can flag indexes that simply haven't had time to be exercised. Sanity-check uptime:

  ```sql
  SELECT pg_postmaster_start_time(), now() - pg_postmaster_start_time() AS uptime;
  ```

  Rule of thumb: under a week of uptime → treat R08 output as suggestive, not authoritative.
- **`pg_stat_reset()` was called.** Same effect as a restart — stats nuked, count starts over.
- **Read replicas absorbing reads** — see Ambiguous above.
- **Indexes created by Prisma `@unique`** that haven't been queried via Prisma but ARE part of the uniqueness constraint. Postgres uses these for constraint enforcement (on insert/update) — that doesn't show up as `idx_scan`. The current rule excludes primary keys but not other unique indexes; this is a known limitation and worth tightening (planned).

## Provider support

| Provider   | Index-usage source                                                          | Behavior                                                                                                                                                                                            |
|------------|-----------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| postgresql | `pg_stat_user_indexes.idx_scan` + `pg_stat_user_tables.seq_scan`            | Full Postgres semantics described above: idx_scan = 0 AND seq_scan > 0 AND rows ≥ minRowCount.                                                                                                      |
| mysql      | `performance_schema.table_io_waits_summary_by_index_usage.count_read`       | Looser semantics — there is no per-table `seq_scan` counter in MySQL. The rule fires on `count_read = 0` AND `approx_rows ≥ minRowCount`. Slightly higher false-positive rate than Postgres, primarily mitigated by `minRowCount`. Requires `performance_schema = ON` (default in MySQL 5.7+ / MariaDB 10.0+); when off, `count_read` returns NULL on every index and the runner sets `capabilities.indexUsageTracking = false` → R08 silently skips with a one-shot stderr warning. |
| sqlite     | none — SQLite does not track per-index usage anywhere                       | Always silently skipped. The runner emits a single stderr warning ("SQLite does not track index usage; this is a permanent provider limitation") if R08 was explicitly requested via `--rules R08`. R07 (redundant) and R09 (drift) on SQLite are unaffected. |

## Implementation notes

- **Capability flag.** The dispatcher returns a `DbSnapshot.capabilities.indexUsageTracking` boolean. R08 returns `[]` whenever it's `false`, so users always get an empty-but-valid run instead of inconsistent partial output.
- **Unique-index exclusion gap.** As noted in Common false positives, the rule excludes `isPrimary` but not `isUnique` more broadly. That can produce false positives on Prisma `@unique` columns. Planned fix (B4 in roadmap): exclude unique indexes by default, expose `R08.includeUnique: true` for users who explicitly want them audited.
- **Ignores tables under `minRowCount`** entirely (not just emits weaker findings).
- **Doesn't suggest dropping** in the message, only flags. The skill is expected to add context based on table activity.

## See also

- R07 — Redundant indexes (different signal — covered, not unused)
- R09 — Schema drift (orthogonal — there might be indexes in DB not in `schema.prisma` that R09 surfaces too)
