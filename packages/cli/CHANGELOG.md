# prisma-zod-consistency

## 0.1.2

### Patch Changes

- Republish 0.1.1 under a new version. The 0.1.1 tarball was published with an empty dist/ (build step was skipped), then unpublished — but npm bans reusing a burned version name, so the same content ships as 0.1.2. No code changes vs. 0.1.1; full polish-for-launch fixes are included (see 0.1.1 entry below for the complete list).



## 0.1.1

### Patch Changes

- 9c63ca7: Polish-for-launch pass — quality fixes uncovered while smoke-testing 0.1.0 on a real Prisma+Zod+Hono codebase:

  - **R03 codemod no longer destroys `.pipe(z.nativeEnum(...))` chains.** The case-insensitive coerce idiom `z.string().transform((v) => v.toUpperCase()).pipe(z.nativeEnum(Foo))` is already correct; the previous version naïvely replaced the leading `z.string()` with `z.nativeEnum(Foo)`, breaking the chain. The detector now also recognizes `.pipe(<knownEnumSchema>)` when the variable is itself bound to the matching Prisma enum in the project.
  - **R01 codemod inserts `.int()` before `.nullable()` / `.optional()` / `.nullish()`.** Previously it appended at the end of the chain, producing `z.number().nullable().int()`. Same applies to `.max(N)` insertion.
  - **R03 fix merges new named imports into the existing `import { ... } from "@prisma/client"`** instead of adding a second import line. Handles single-line and multi-line import blocks, with or without trailing comma.
  - **R02 reports real source line numbers** via a token-scan fallback when `@mrleebo/prisma-ast` doesn't provide them on attribute nodes (which is most of the time). Findings now point at the actual `field @relation(...)` line, not always `:1`.
  - **`pz-fix` dry-run output uses a real Myers-based unified diff** (via the `diff` package) — unchanged context lines no longer appear with `+`/`-` markers.
  - **Build script now runs `chmod +x dist/index.js`** so CI builds preserve the executable bit. The 0.1.0 publish needed a manual chmod and squeaked through despite warnings; this prevents a regression.

  Test suite: +8 vitest cases covering all of the above (33 tests total, all green). New devDep: `@types/diff` and runtime dep: `diff`.

## 0.1.0

### Minor Changes

- ceea60b: Initial public release of the `prisma-zod-consistency` CLI.

  Static rules (no DB needed):

  - **R01** — Zod ↔ Prisma field drift (hand-written mode), with `pz-fix` codemod for `.max(N)` / `.int()` adjustments
  - **R02** — `@relation` without explicit `onDelete`
  - **R03** — Prisma enum ↔ Zod enum sync, with `pz-fix` codemod that swaps `z.string()` for `z.nativeEnum(...)`
  - **R04** — Nullability mismatch between Prisma and Zod
  - **R05** — API boundary bypass (Hono detector — request handlers reading body without Zod validation)

  Live-DB rules (Postgres, behind `--db` flag):

  - **R07** — Redundant indexes
  - **R08** — Unused indexes (uses `pg_stat_user_indexes`)
  - **R09** — Schema drift vs live DB (column existence + nullability)

  Plus:

  - `pz-fix` subcommand with dry-run by default and `--apply` to write
  - `pretty` and `json` output formats; `sarif` is a reserved placeholder for the next release
  - cosmiconfig-based config (`.prismazodrc.{json,js,cjs,mjs}`, `prismazod.config.*`, or `package.json` field)
  - Two binaries: `prisma-zod-consistency` (canonical) and `pz-check` (alias)

  Skill bundles for Claude Code and Codex ship in the same repo but are not versioned via changesets — they ride with git tags.
