# R07 — Redundant indexes

**Severity (default):** info
**Phase:** 1.5
**Surface:** skill only
**Group:** B (live DB)

## Status

Stub. Full spec lands with Phase 1.5 implementation.

## Summary

Detects indexes where one fully covers another (e.g. `(a)` covered by `(a, b)`). Requires `pg_indexes` introspection.
