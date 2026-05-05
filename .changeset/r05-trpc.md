---
"prisma-zod-consistency": minor
---

R05 now detects bypass'ed boundaries in tRPC routers — procedures whose handler accepts `input` but never declared `.input(zodSchema)` in the chain. Detection is import-gated on `@trpc/server`. The `framework` config gains `"trpc"` and the default `"auto"` now runs every detector whose import is present (Hono + tRPC together for projects that use both).

Explicit no-input declarations (`.input(z.void())`, `.input(z.undefined())`, `.input(z.never())`) and procedures whose handler takes no arguments are not flagged.
