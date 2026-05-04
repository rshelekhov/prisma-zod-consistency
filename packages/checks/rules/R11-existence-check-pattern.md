# R11 — `select: { id: true }` for existence checks

**Severity (default):** info
**Phase:** 1.7
**Surface:** skill only
**Group:** C (patterns)

## Status

Stub. Full spec lands with Phase 1.7 implementation.

## Summary

Detects `prisma.x.findFirst({ where, select: { id: true } })` (or similar) followed by a truthiness check on the result. These should usually be `prisma.x.count({ where, take: 1 })` or — when available — a dedicated existence helper, which avoids materializing a row.

Lives behind `--mode patterns`.
