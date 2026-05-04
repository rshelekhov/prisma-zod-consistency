# R10 — N+1 queries

**Severity (default):** info
**Phase:** 1.7
**Surface:** skill only
**Group:** C (patterns)

## Status

Stub. Full spec lands with Phase 1.7 implementation.

## Summary

Heuristic: a Prisma `findMany`/`findUnique` call inside a `for`/`forEach`/`map`/`Promise.all(map(...))` loop, with no `include` or `select` on the parent query that could have hydrated the relation in one round trip.

This rule is intentionally noisy — it lives behind `--mode patterns` and is never enabled by default.
