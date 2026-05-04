# prisma-zod-consistency (CLI)

Deterministic static analysis for Prisma + Zod + TypeScript projects. Run in CI; gives a green/red verdict.

For context-aware analysis and suggested fixes, use the companion [skill](../skill-claude-code) (Claude Code) or [AGENTS.md](../skill-codex) (Codex).

## Status

Pre-alpha. Scaffold only — only R02 is wired through end-to-end as a proof of concept. Other rules are stubs.

## Install

```bash
# Not yet published — package is currently marked private until R01-R05 are stable.
pnpm add -D prisma-zod-consistency
```

## Usage

The package installs two equivalent binaries:

- `prisma-zod-consistency` — the canonical name (use in CI scripts and docs).
- `pz-check` — short alias for interactive use.

```bash
prisma-zod-consistency                      # run default rules against current project
prisma-zod-consistency --rules R01,R02,R03  # run a subset
prisma-zod-consistency --output json        # machine-readable
prisma-zod-consistency --output sarif       # for GitHub Code Scanning (Phase 2)

# Equivalent shorthand:
pz-check
pz-check --rules R01,R02,R03
```

## Live DB mode (Group B)

R07 (redundant indexes), R08 (unused indexes), and R09 (schema drift between `schema.prisma` and the actual database) need a live connection.

```bash
DATABASE_URL=postgres://... prisma-zod-consistency --rules R07,R08,R09 --db
# or pass it explicitly:
prisma-zod-consistency --rules R07,R08,R09 --db --database-url postgres://...
```

Without `--db`, R07/R08/R09 are silently skipped — `pz-check` always works without a database for the static rules.

Currently Postgres only. MySQL/SQLite need their own dialect adapters.

## Auto-fix

A subset of findings ship a mechanical, safe codemod that `pz-fix` can apply:

- **R01**: missing `.max(N)` (appends to chain), missing `.int()` on `Int` fields, looser `.max(M)` (rewrites to match Prisma).
- **R03**: field-level `z.string()` / `z.number()` where Prisma is an enum → `z.nativeEnum(EnumName)` plus an auto-import from `@prisma/client` if the enum isn't already in scope.

```bash
prisma-zod-consistency fix                 # dry-run: prints a diff, exits 0
prisma-zod-consistency fix --apply         # writes changes to disk
prisma-zod-consistency fix --rules R01     # restrict to one rule
```

What is **not** auto-fixed (deliberately):
- Schema-side changes (`schema.prisma` is never touched — those imply migrations).
- R03 enum value mismatches (removing a value from `z.enum([...])` could break compile-time references elsewhere).
- R02, R04, R05 (no safe mechanical fix — the right action is contextual).

## Configuration

Create a `.prismazodrc.json` (or `.prismazodrc.js`, or a `prisma-zod-consistency` field in `package.json`):

```jsonc
{
  "schemaPath": "prisma/schema.prisma",
  "include": ["src/**/*.ts"],
  "exclude": ["**/*.test.ts"],
  "rules": {
    "R02": { "severity": "error" }
  }
}
```

## Exit codes

- `0` — no findings at `error` severity
- `1` — at least one `error` finding
- `2` — bad CLI invocation or configuration

## Rules

See [`packages/checks/rules/`](../checks/rules) for the full rule catalog.

## License

MIT
