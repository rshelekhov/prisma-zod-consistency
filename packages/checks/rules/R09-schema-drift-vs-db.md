# R09 — Schema drift vs live DB

**Severity (default):** warning
**Phase:** 1.5
**Surface:** skill only
**Group:** B (live DB)

## Status

Stub. Full spec lands with Phase 1.5 implementation.

## Summary

Compares `schema.prisma` against the actual database via `information_schema.columns`, catching cases that `prisma migrate diff` misses (manual SQL migrations, custom DDL, columns added by other services).
