---
"prisma-zod-consistency": patch
---

Polish-for-launch pass — quality fixes uncovered while smoke-testing 0.1.0 on a real Prisma+Zod+Hono codebase:

- **R03 codemod no longer destroys `.pipe(z.nativeEnum(...))` chains.** The case-insensitive coerce idiom `z.string().transform((v) => v.toUpperCase()).pipe(z.nativeEnum(Foo))` is already correct; the previous version naïvely replaced the leading `z.string()` with `z.nativeEnum(Foo)`, breaking the chain. The detector now also recognizes `.pipe(<knownEnumSchema>)` when the variable is itself bound to the matching Prisma enum in the project.
- **R01 codemod inserts `.int()` before `.nullable()` / `.optional()` / `.nullish()`.** Previously it appended at the end of the chain, producing `z.number().nullable().int()`. Same applies to `.max(N)` insertion.
- **R03 fix merges new named imports into the existing `import { ... } from "@prisma/client"`** instead of adding a second import line. Handles single-line and multi-line import blocks, with or without trailing comma.
- **R02 reports real source line numbers** via a token-scan fallback when `@mrleebo/prisma-ast` doesn't provide them on attribute nodes (which is most of the time). Findings now point at the actual `field @relation(...)` line, not always `:1`.
- **`pz-fix` dry-run output uses a real Myers-based unified diff** (via the `diff` package) — unchanged context lines no longer appear with `+`/`-` markers.
- **Build script now runs `chmod +x dist/index.js`** so CI builds preserve the executable bit. The 0.1.0 publish needed a manual chmod and squeaked through despite warnings; this prevents a regression.

Test suite: +8 vitest cases covering all of the above (33 tests total, all green). New devDep: `@types/diff` and runtime dep: `diff`.
