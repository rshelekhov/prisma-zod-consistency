---
"prisma-zod-consistency": minor
---

0.8.0 — multi-file Prisma schemas, Zod 4 native enums, naming-prefix config, R01 directionality, and zero-findings UX.

**Bug fixes (surfaced by smoke on dub / documenso / formbricks)**

- **Multi-file Prisma schemas (Prisma 5.15+ `prismaSchemaFolder`, default in 6.x).** `schemaPath` now accepts either a single `.prisma` file or a directory; sibling files are auto-concatenated, duplicate `datasource`/`generator` blocks are stripped from non-entry files, and findings report against the original file (e.g. `prisma/post.prisma:14`, not the synthetic combined position). On dub this lifts the visible model count from 3/80 to 80/80.
- **Z-prefix Zod naming convention.** `matchSchemasToModels` now strips a configurable list of single-character PascalCase prefixes (default `["Z"]`) with a PascalCase boundary check, so `ZUser` → `User` while `Zone` stays `Zone`. Configurable via `namingPrefixes` in `.prismazodrc.json`.
- **R03 understands the Zod 4 `z.enum(IDENT)` shorthand.** Resolves the identifier through ts-morph (TS `enum X` and `const X = {...} as const`), with a Prisma-registry name-match fallback for monorepo `@prisma/client` re-exports. Cuts dub's 38 R03 findings (97% false-positive) down to true drift only.
- **Hybrid mode detection now recognises `zod/v3` and `zod/v4` import paths.** Was matching only the bare `from "zod"` import, missing Zod 4 codebases entirely.

**New features**

- **`R01.directionalityMode`** — classifies each drift as `zod-weaker` / `zod-stricter` / `type-mismatch` and lets you tune severity. `"strict"` (default, backwards-compatible), `"actionable"` (info on `zod-stricter` like `z.email()` for `String`), `"off-stricter"` (drop `zod-stricter` entirely). The default will switch to `"actionable"` in 1.0.0.
- **`namingPrefixes`** — top-level config option, default `["Z"]`. Add `"T"` / `"I"` if your project uses them, or `[]` to disable.
- **Zero-findings discovery summary** — `pretty` output on R01/R03/R04 runs now includes `(N Prisma models, M Zod schemas, K matched)` so users can tell "tool ran clean" from "tool didn't see what I expected". When `K === 0` the summary upgrades to an actionable warning that points at `namingPrefixes`.

**Specs and docs**

- R01 spec gains a "Directionality" section with a table of the three modes.
- R03 spec documents the three-step Zod 4 resolution ladder (TS-morph → Prisma name match → info note).
- `docs/getting-started.md` covers `namingPrefixes`, `directionalityMode`, and multi-file schema support.
- CLI README config example covers all three new knobs.
