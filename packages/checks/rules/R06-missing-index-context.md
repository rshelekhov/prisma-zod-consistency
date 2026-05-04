# R06 — Missing index for `where`/`orderBy` (contextual)

**Severity (default):** info
**Phase:** 1
**Surface:** skill only
**Group:** A (static + context)

## Status

Stub. Full spec lands with Phase 1 implementation.

## Summary

Skill-only rule. Scans Prisma calls in services/repositories for `where` and `orderBy` clauses that filter or sort by a field with no covering index in `schema.prisma`. Recommends the index when the call site looks hot (lives in a request handler, not a one-off script or migration).

This rule is intentionally not in the CLI because the "is this hot?" judgement requires context the CLI cannot reliably reconstruct.

## See also

- R07 — Redundant indexes
- R08 — Unused indexes
