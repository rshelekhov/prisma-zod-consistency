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
