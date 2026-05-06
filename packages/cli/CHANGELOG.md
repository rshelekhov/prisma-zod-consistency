# prisma-zod-consistency

## 0.8.0

### Minor Changes

- 5ea7210: 0.8.0 — multi-file Prisma schemas, Zod 4 native enums, naming-prefix config, R01 directionality, and zero-findings UX.

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

## 0.7.0

### Minor Changes

- 2c9b499: Polish #2 — three new live-DB rules and an R08 false-positive fix.

  ## What's new

  - **R09b — type drift vs live DB.** Compares the Prisma field type (with `@db.*` modifiers) against the actual column type the database reports. Catches `@db.VarChar(100)` ↔ `varchar(255)`, `Int` ↔ `bigint`, `text` ↔ `varchar`, and similar mismatches that R09 (column existence + nullability) doesn't address. Postgres + MySQL fully covered. SQLite silently skipped via the new `DbCapabilities.typeDriftAccurate = false` capability flag — affinity-based typing makes the comparison unreliable; the runner emits a one-shot stderr warning when R09b is explicitly requested on SQLite.

  - **R09c — foreign-key constraints drift vs live DB.** Compares Prisma `@relation(fields:..., references:..., onDelete:..., onUpdate:...)` against the constraints reported by the database. Three classes of finding: missing FK in DB, orphan FK in DB, and action drift (`onDelete: Cascade` in Prisma vs `NO ACTION` in DB). Honors `@map(...)` and `@@map(...)`. Multi-column FKs supported. Postgres + MySQL + SQLite all covered.

  - **R09d — default-value drift vs live DB.** Compares Prisma `@default(...)` against the column DEFAULT reported by the database, with normalization for Postgres `::type` casts, numeric forms (`42` ↔ `42.0`), boolean spellings (`true` ↔ `'t'` ↔ `1`), and the clock-default family (`now()` ↔ `CURRENT_TIMESTAMP` ↔ `current_timestamp(3)`). Generated defaults — `cuid()` / `uuid()` / `autoincrement()` / `dbgenerated(...)` on the Prisma side and `nextval(...)` / `gen_random_uuid()` on the DB side — are intentionally skipped. Postgres + MySQL + SQLite all covered.

  - **R08: exclude unique non-PK indexes by default (B4).** Postgres / MySQL bump `idx_scan` / `count_read` only on read-path lookups; a unique index used purely for constraint enforcement on inserts/updates therefore looks "unused" by this metric, producing steady noise on every Prisma `@unique` column. The rule now skips them by default. Re-enable via `R08.includeUnique = true` for one-off audits.

  ## DbSnapshot extensions

  - `DbColumn.columnDefault: string | null` — raw DEFAULT expression as the provider reports it (Postgres / MySQL / SQLite all populate).
  - `DbSnapshot.foreignKeys: DbForeignKey[]` — normalized FK list, including parallel `columns` / `referencedColumns` arrays for multi-column FKs and a `ForeignKeyAction` discriminated vocabulary (`cascade` / `restrict` / `no action` / `set null` / `set default`).
  - `DbCapabilities.typeDriftAccurate: boolean` — `true` for Postgres/MySQL, `false` for SQLite. Drives R09b silent-skip the same way `indexUsageTracking` drives R08.

  These are additive shape changes — existing consumers get the new fields populated automatically and can ignore them.

  ## Configuration

  ```jsonc
  {
    "rules": {
      "R08": { "includeUnique": false }, // new flag
      "R09b": { "ignoreTables": [], "ignoreColumns": [] }, // new rule
      "R09c": { "ignoreTables": [], "ignoreRelations": [] }, // new rule
      "R09d": { "ignoreTables": [], "ignoreColumns": [] } // new rule
    }
  }
  ```

  `ignoreRelations` on R09c is matched against `Model.field` (e.g. `Membership.org`); the others use `column_name`. Full per-rule docs in `packages/checks/rules/R09{b,c,d}-*.md`.

## 0.6.0

### Minor Changes

- 5a7892b: Group B (live-DB) rules now support **MySQL/MariaDB** and **SQLite** in addition to PostgreSQL.

  ## What's new

  - **MySQL adapter** (`mysql2`) — R07/R08/R09 work against any MySQL 5.7+ / MariaDB 10.0+ instance. Index metadata comes from `INFORMATION_SCHEMA.STATISTICS`; index-usage statistics for R08 from `performance_schema.table_io_waits_summary_by_index_usage` (default-on in 5.7+; if disabled, R08 silently skips with a stderr warning).
  - **SQLite adapter** (`better-sqlite3`) — R07 (redundant indexes) and R09 (schema drift) work against any SQLite database. R08 (unused indexes) is silently skipped because SQLite does not track per-index read counts; the runner emits one stderr warning when R08 is explicitly requested on SQLite.
  - **Provider dispatch** — `runner.ts` no longer hard-gates on `provider === "postgresql"`. Group B rules now run for `postgresql / mysql / sqlite`. Other providers (`sqlserver`, `mongodb`, `cockroachdb`) get a clear error with no attempt to introspect.
  - **Capability flag** — `DbSnapshot` gains `capabilities: { indexUsageTracking: boolean }`, consumed by R08 to decide whether to run.
  - **R07/R08/R09 specs** updated with a per-provider matrix documenting what each adapter sees and the semantic differences (especially for R08 on MySQL vs Postgres).

  ## Breaking change — database drivers are now optional peer dependencies

  Previously `postgres` was a runtime dependency of the CLI. Now `postgres`, `mysql2`, and `better-sqlite3` are all **optional peer dependencies**. Install only the driver for the provider you actually use:

  ```bash
  # PostgreSQL projects:
  pnpm add -D postgres

  # MySQL/MariaDB projects:
  pnpm add -D mysql2

  # SQLite projects:
  pnpm add -D better-sqlite3
  ```

  If you only use the static rules (R01–R05) you don't need any of these. Running `--db` without the matching driver fails with an actionable error message that names the install command.

  This shift keeps the install lightweight (no native SQLite binary for users who don't touch SQLite, no second SQL driver pulled in) and is consistent with how other multi-DB libraries in the ecosystem handle drivers (e.g. drizzle-orm, kysely). Pre-1.0 was the right window for the change.

## 0.5.0

### Minor Changes

- 49d6d37: R05 now detects bypass'ed boundaries in Next.js applications across three surfaces: App Router Route Handlers (`app/**/route.{ts,tsx,js,jsx}`), Server Actions (file-level `'use server'` exports and inline `'use server'` directives), and Pages Router API routes (`pages/api/**/*.{ts,tsx,js,jsx}`).

  Route Handler detection flags `<request>.json()`, `<request>.formData()`, `<request>.blob()`, and `<request>.arrayBuffer()` calls on the first parameter of any HTTP-method export. Server Action detection flags `<formData>.get(...)` (and friends) reads on a `FormData` parameter when the function does not also call `<schema>.parse(<formData>)` or `<schema>.parse(Object.fromEntries(<formData>))`. Pages API detection flags `<req>.body` direct access on the default-export handler. Files importing known wrappers (`next-safe-action`, `zsa`, `zact`) are skipped wholesale.

  `<request>.text()` and `<request>.body` stream access (`.body.getReader()`) are intentionally not flagged — webhooks legitimately read raw text for signature verification, and stream access is a streaming/SSE pattern.

  The `framework` config gains `"next"`, and the default `"auto"` now picks up Next.js automatically via path detection (`app/.../route.*`, `pages/api/...`), Next imports (`next`, `next/*`), or `'use server'` directives.

## 0.4.0

### Minor Changes

- d4f363f: R05 now detects bypass'ed boundaries in tRPC routers — procedures whose handler accepts `input` but never declared `.input(zodSchema)` in the chain. Detection is import-gated on `@trpc/server`. The `framework` config gains `"trpc"` and the default `"auto"` now runs every detector whose import is present (Hono + tRPC together for projects that use both).

  Explicit no-input declarations (`.input(z.void())`, `.input(z.undefined())`, `.input(z.never())`) and procedures whose handler takes no arguments are not flagged.

## 0.3.0

### Minor Changes

- bc9ae98: R01 truly complete: implement R01b (generator output ↔ Prisma sanity check) and R01c (derived schemas weakening generated).

  R01 now runs all three sub-modes coordinately, dispatched per-schema:

  - **R01a** (existing) — hand-written `z.object({...})` compared to the matching Prisma model.
  - **R01b** (new) — every schema declared inside the Zod-generator `outputDir` is sanity-checked against Prisma. Catches stale generator output, contradictory `@zod.string.max(N)` annotations, and missing `.int()` on `Int` columns. Default severity: warning. No mechanical fixes (the user can't auto-edit a regenerated file).
  - **R01c** (new) — derived chains (`UserSchema.passthrough()`, `UserSchema.pick({...}).extend({...})`, etc.) where the base identifier resolves into `outputDir` are checked for weakening calls. `.passthrough()` is flagged as **error** — it defeats the validator. `.nonstrict()` is flagged as warning. Identifier resolution traverses barrel re-exports and `import { X as Y }` aliases transitively, so weakening through indirection is still caught.

  The first-class supported generator is `zod-prisma-types`. `prisma-zod-generator` and `zod-prisma` are detected best-effort.

  R01a behaviour is unchanged. The runner's per-schema dispatch means a single file can host R01a, R01c, and (transitively) R01b schemas side by side without conflict.

## 0.2.0

### Minor Changes

- eac5864: Enterprise-readiness pack — SARIF output + suppression comments.

  - **`--output sarif`** emits a SARIF 2.1.0 document conforming to the OASIS-TCS schema. Feed it to `github/codeql-action/upload-sarif@v3` for inline PR annotations and a Security-tab dashboard. Severity maps as `error`→`error`, `warning`→`warning`, `info`→`note`. Each rule's `helpUri` points at its spec on GitHub. Live-DB findings emit a generic repository annotation since they aren't anchored to source.

  - **Suppression comments** silence individual findings without disabling a rule globally. Familiar `// pz-disable-next-line`, `// pz-disable` … `// pz-enable` syntax with optional rule lists, wildcards, and ESLint-style trailing reasons (`-- because X`). Scope: TS/TSX files for R01, R03, R04, R05. Per-rule hard-gate via `R0X.suppressionsEnabled: false`.

  Also: `--version` now reports the actual published CLI version (was hardcoded to `0.0.0`).

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
