# R05 — API boundary bypass

**Severity (default):** warning
**Phase:** 1 (skill); CLI only if a standardized middleware pattern is configured
**Surface:** both
**Group:** A (static)

## Status

Stub. Full spec lands with Phase 1 implementation.

## Summary

Every route handler that accepts a request body must pass it through a Zod schema before the value reaches a Prisma write call (`create`, `update`, `upsert`, `createMany`, `updateMany`).

The rule is framework-aware: for projects using `@hono/zod-validator` (or a wrapper like `validated('json', schema)`), it checks that no handler reads `c.req.json()` / `c.req.param()` / `c.req.query()` directly without going through the validator. Equivalent patterns exist for tRPC (`procedure.input(...)`), Next.js Route Handlers, Express middlewares, etc.

## Configuration

```jsonc
{
  "R05": {
    "severity": "warning",
    "framework": "hono",                  // hono | trpc | next | express | auto
    "validatorImport": "@hono/zod-validator",
    "wrapperName": "validated"            // your project-local wrapper, if any
  }
}
```

## See also

- R01 — Zod ↔ Prisma field drift
