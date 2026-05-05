---
"prisma-zod-consistency": minor
---

R01 truly complete: implement R01b (generator output ↔ Prisma sanity check) and R01c (derived schemas weakening generated).

R01 now runs all three sub-modes coordinately, dispatched per-schema:

- **R01a** (existing) — hand-written `z.object({...})` compared to the matching Prisma model.
- **R01b** (new) — every schema declared inside the Zod-generator `outputDir` is sanity-checked against Prisma. Catches stale generator output, contradictory `@zod.string.max(N)` annotations, and missing `.int()` on `Int` columns. Default severity: warning. No mechanical fixes (the user can't auto-edit a regenerated file).
- **R01c** (new) — derived chains (`UserSchema.passthrough()`, `UserSchema.pick({...}).extend({...})`, etc.) where the base identifier resolves into `outputDir` are checked for weakening calls. `.passthrough()` is flagged as **error** — it defeats the validator. `.nonstrict()` is flagged as warning. Identifier resolution traverses barrel re-exports and `import { X as Y }` aliases transitively, so weakening through indirection is still caught.

The first-class supported generator is `zod-prisma-types`. `prisma-zod-generator` and `zod-prisma` are detected best-effort.

R01a behaviour is unchanged. The runner's per-schema dispatch means a single file can host R01a, R01c, and (transitively) R01b schemas side by side without conflict.
