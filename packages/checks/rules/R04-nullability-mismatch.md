# R04 — Nullability mismatch

**Severity (default):** error
**Phase:** 1 (skill), 2 (CLI)
**Surface:** both
**Group:** A (static)

## Status

Stub. Full spec lands with Phase 1 implementation.

## Summary

Prisma `String?` (and any other optional column) maps to Zod `.nullable()` (database can return `null`) and/or `.optional()` (request body may omit the key) depending on the schema's purpose (DTO vs. input).

This rule checks the mapping is consistent and the right modifier is used for the schema's role.

## See also

- R01 — Zod ↔ Prisma field drift (parent rule)
