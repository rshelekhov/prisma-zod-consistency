# @prisma-zod-consistency/cli

Deterministic static analysis for Prisma + Zod + TypeScript projects. Run in CI; gives a green/red verdict.

For context-aware analysis and suggested fixes, use the companion [skill](../skill-claude-code) (Claude Code) or [AGENTS.md](../skill-codex) (Codex).

## Status

Pre-alpha. Scaffold only — only R02 is wired through end-to-end as a proof of concept. Other rules are stubs.

## Install

```bash
# Not yet published.
pnpm add -D @prisma-zod-consistency/cli
```

## Usage

```bash
pz-check                       # run default rules against current project
pz-check --rules R01,R02,R03   # run a subset
pz-check --output json         # machine-readable
pz-check --output sarif        # for GitHub Code Scanning (Phase 2)
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
