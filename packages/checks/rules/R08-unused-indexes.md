# R08 — Unused indexes

**Severity (default):** info
**Phase:** 1.5
**Surface:** skill only
**Group:** B (live DB)

## Status

Stub. Full spec lands with Phase 1.5 implementation.

## Summary

Indexes with `idx_scan = 0` over a meaningful sample period in `pg_stat_user_indexes`, on tables that have non-trivial `seq_scan` activity. Requires live DB access via Postgres MCP or DATABASE_URL.
