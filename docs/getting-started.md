# Getting started

Five-minute walkthrough: from `npx` to a green CI check on your own Prisma + Zod project.

## What this tool does

`prisma-zod-consistency` finds drift between three things that are supposed to agree but routinely don't:

1. **`schema.prisma`** — the database schema
2. **Zod schemas** — runtime validation at the API boundary
3. **TypeScript code** — how those schemas are actually used (and bypassed)

It runs as a deterministic linter (suitable for CI), and ships with two AI-driven skill bundles for context-aware reviews inside Claude Code or Codex. This guide covers the CLI.

## Prerequisites

- Node.js 20+
- A Prisma project (`schema.prisma` somewhere in your repo)
- Zod schemas (hand-written, generated, or both — see [R01](../packages/checks/rules/R01-zod-prisma-field-drift.md) for what each mode means)

## 1. Try it without installing

```bash
npx prisma-zod-consistency
```

That's it. From the root of your project, this:

- Looks for `prisma/schema.prisma`
- Looks for Zod schemas under `src/**/*.{ts,tsx}` (configurable)
- Detects whether you use a Zod generator (e.g. `zod-prisma-types`) by reading `generator` blocks in `schema.prisma`. R01 then runs in three coordinated sub-modes — R01a checks hand-written `z.object({...})` schemas against Prisma; R01b sanity-checks the generator's *output* against Prisma; R01c flags hand-written schemas that derive from generated ones (`UserSchema.passthrough()`, etc.) and weaken them
- Runs all rules whose preconditions are met and prints findings

If nothing's wrong, you get a clean exit. If there's drift, you get a report. **Exit code 0** means no `error`-severity findings. **Exit code 1** means at least one error — that's the CI gate.

## 2. Install it for real

Once you've decided you want it in CI:

```bash
pnpm add -D prisma-zod-consistency
# or: npm install --save-dev prisma-zod-consistency
# or: yarn add -D prisma-zod-consistency
```

The package installs two equivalent binaries:

- `prisma-zod-consistency` — canonical name for CI scripts
- `pz-check` — short alias for interactive use

Both run the same code; pick whichever reads better in your context.

## 3. Read the output

Default human-readable format:

```
src/schemas/user.ts:14
  R01 [error] Field `email` is `@db.VarChar(255)` in Prisma but Zod has no .max() constraint.
  → Add `.max(255)` to email in userSchema.

prisma/schema.prisma:42
  R02 [warning] Relation `User.organization` has no explicit @relation onDelete.
  → Set onDelete: Cascade | Restrict | SetNull | NoAction explicitly.

Summary: 1 error, 1 warning, 0 info
```

Machine-readable (JSON):

```bash
prisma-zod-consistency --output json > findings.json
```

Then filter with `jq`, store the artifact in CI, etc. See the [CLI README](../packages/cli/README.md#json-shape) for the full schema.

## 4. Configure (optional)

The defaults work for most projects. You add a config when you need to:

- Point at a non-standard `schema.prisma` location
- Narrow the include/exclude globs
- Tune severity per rule, ignore specific models or relations
- Configure live-DB rules (R07/R08/R09)

Pick one of these locations (cosmiconfig searches up from cwd):

- `.prismazodrc.json` (or `.js`, `.cjs`, `.mjs`)
- `prismazod.config.{js,cjs,mjs}`
- `"prisma-zod-consistency"` field in `package.json`

Minimal example:

```jsonc
// .prismazodrc.json
{
  "schemaPath": "prisma/schema.prisma",
  "include": ["src/**/*.ts"],
  "exclude": ["**/*.test.ts", "**/*.spec.ts", "**/node_modules/**"],

  "rules": {
    "R02": { "severity": "warning", "requireOnUpdate": false },
    "R05": { "severity": "warning", "framework": "auto" }   // hono | trpc | next | auto | off
  }
}
```

If you use Next.js with `app/` or `pages/` at the project root (no `src/` directory), extend `include` so the Next sub-walkers see those files:

```jsonc
{
  "include": ["src/**/*.ts", "src/**/*.tsx", "app/**/*.{ts,tsx}", "pages/**/*.{ts,tsx}"]
}
```

Per-rule options live in the rule specs at [`packages/checks/rules/`](../packages/checks/rules).

### Silence individual findings without disabling a rule

When a finding is intentional (e.g. legacy DTO shape, signature-verified webhook), drop a suppression comment in the source instead of editing config:

```typescript
// pz-disable-next-line R03
status: z.string(), // legacy public API contract — enum drift is intentional

// Block form, until pz-enable or end of file:
// pz-disable R05
webhookHandler.post("/square", async (c) => { ... });
// pz-enable R05
```

Works in TS/TSX files for R01, R03, R04, R05. Full grammar (wildcards, multi-rule lists, eslint-style trailing reasons) is in the [CLI README](../packages/cli/README.md#suppression-comments).

## 5. Auto-fix the safe subset

For two rules (R01 and R03) the fix is mechanical and safe to apply:

```bash
# Preview the diff:
prisma-zod-consistency fix

# Apply:
prisma-zod-consistency fix --apply
```

What gets fixed:

- **R01** (R01a only) — appends `.max(N)` to Zod fields backed by `@db.VarChar(N)`, appends `.int()` for `Int` fields, lowers a too-loose `.max(M)`. R01b/R01c findings stand on their own — generator output isn't auto-edited (regenerate it instead), and the right replacement for `.passthrough()` depends on intent
- **R03** — replaces `z.string()` with `z.nativeEnum(EnumName)` when the Prisma field is an enum (auto-imports `EnumName` from `@prisma/client`)

What is **not** auto-fixed:

- `schema.prisma` is never touched (schema changes imply migrations)
- R02 / R04 / R05 — the right action is contextual, no safe mechanical rewrite

## 6. Live-DB mode (R07/R08/R09)

The static rules don't need a database. The Group B rules do — they snapshot the live DB and compare it against `schema.prisma`:

- **R07** — redundant indexes
- **R08** — unused indexes (per-index read counters)
- **R09** — schema drift (column-level)

Supported providers: **PostgreSQL**, **MySQL/MariaDB**, **SQLite**. The driver for each is an optional peer dependency — install only the one your project uses:

```bash
# PostgreSQL
pnpm add -D postgres
DATABASE_URL=postgres://user:pass@host:5432/dbname \
  prisma-zod-consistency --db --rules R07,R08,R09

# MySQL / MariaDB
pnpm add -D mysql2
DATABASE_URL=mysql://user:pass@host:3306/dbname \
  prisma-zod-consistency --db --rules R07,R08,R09

# SQLite (R08 silently skipped — provider doesn't track index usage)
pnpm add -D better-sqlite3
DATABASE_URL=file:./prisma/dev.db \
  prisma-zod-consistency --db --rules R07,R09
```

Without `--db`, Group B rules silently skip — same binary works in CI jobs that have DB access and ones that don't.

R08 needs per-index read counters. On Postgres they come from `pg_stat_user_indexes` (always on). On MySQL they come from `performance_schema.table_io_waits_summary_by_index_usage` (default-on in 5.7+); if `performance_schema` is disabled, R08 silently skips with a stderr warning. SQLite never tracks index usage, so R08 always skips on SQLite — the runner emits one warning when R08 is explicitly requested. R07 (redundant) and R09 (drift) work uniformly on all three providers.

## 7. Wire it into CI

Minimal GitHub Actions step:

```yaml
- name: Prisma+Zod consistency
  run: pnpm exec prisma-zod-consistency --output json > pzc-findings.json

- if: failure()
  run: |
    echo "::group::Errors"
    jq '.findings[] | select(.severity == "error")' pzc-findings.json
    echo "::endgroup::"
```

For Group B you typically want a separate job that has DB access:

```yaml
- run: |
    DATABASE_URL=${{ secrets.DATABASE_URL }} \
      prisma-zod-consistency --rules R07,R08,R09 --db --output json \
      > pzc-db-findings.json
```

### Surface findings in GitHub Code Scanning (SARIF)

For inline PR annotations and a Security-tab dashboard, emit SARIF and upload via the codeql-action:

```yaml
- name: Prisma+Zod consistency
  run: pnpm exec prisma-zod-consistency --output sarif > pzc.sarif

- name: Upload SARIF to Code Scanning
  if: always()
  uses: github/codeql-action/upload-sarif@v3
  with:
    sarif_file: pzc.sarif
```

Findings then show up as line annotations on PRs, with each rule's spec linked from its `helpUri`. Severity maps as `error`→`error`, `warning`→`warning`, `info`→`note`.

## 8. Where to go from here

- **Full flag reference** — [`packages/cli/README.md`](../packages/cli/README.md)
- **All rules with examples** — [`packages/checks/rules/`](../packages/checks/rules)
- **Skill bundle (Claude Code)** — [`packages/skill-claude-code/`](../packages/skill-claude-code)
- **Skill bundle (Codex / AGENTS.md)** — [`packages/skill-codex/`](../packages/skill-codex)

If something looks like a false positive, check the rule spec's "Common false positives" section first — most of them are documented with the right config knob to silence.

## Troubleshooting

**`schema.prisma not found`** — your project keeps it somewhere other than `prisma/schema.prisma`. Set `schemaPath` in config.

**`Unsupported or missing datasource provider`** — your `datasource` block doesn't declare a `provider`, or it's a provider this tool doesn't recognize. Currently supported: `postgresql`, `mysql`, `sqlite`, `sqlserver`, `mongodb`, `cockroachdb`.

**No findings, but you expected some** — check that your `include` glob actually matches your Zod schemas. Run with `--rules R04` (the loudest static rule) to verify rules are reaching your files.

**`DATABASE_URL not set`** — you passed `--db` but no URL is exported in the environment. Either export it, or pass `--database-url <url>`.
