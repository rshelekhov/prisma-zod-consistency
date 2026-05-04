# prisma-zod-consistency

Consistency checks for the Prisma + Zod + TypeScript stack — find drift between your database schema, your validation schemas, and the way they're used in code.

Inspired by Ruby's [`database_consistency`](https://github.com/djezzzl/database_consistency), adapted for the TS ecosystem and shipped as both a deterministic CLI and an AI-driven skill.

## Status

Pre-alpha. Scaffolding only. Not published to npm yet.

## What's in the box

This is a monorepo with four packages:

| Package | What it does |
|---|---|
| `packages/checks` | Source of truth for all rules — markdown specs + good/bad examples. Consumed by both the CLI and the skills. |
| `packages/cli` | `prisma-zod-consistency` — the published npm package (currently `private: true` while in pre-alpha). Deterministic static analysis for CI. |
| `packages/skill-claude-code` | Skill bundle for Claude Code. Adds context-aware analysis and suggested fixes. |
| `packages/skill-codex` | `AGENTS.md` instructions for Codex. Same checks, Codex format. |

## Why two faces (CLI + skill)?

- **CLI** runs in CI, gives a green/red verdict, no false-positive tolerance — only deterministic, low-noise rules.
- **Skill** has context, can read service-layer code, can suggest fixes, can reach out to live DB via Postgres MCP. Catches what static analysis can't, but isn't a CI gate.

The two share the same rule definitions in `packages/checks` so they don't drift.

## Local development

Requires Node 20+ and pnpm 9.

```bash
pnpm install
pnpm build
pnpm test
```

## Roadmap

See [docs/implementation-plan.md](docs/implementation-plan.md) for the phased roadmap (Phase 1: skill MVP for Group A static checks → Phase 1.5: live DB audit → Phase 2: CLI MVP → Phase 2.5: CLI DB mode + SARIF output).

## Publishing

The `prisma-zod-consistency` CLI package is currently marked `private: true` while the rule set is in pre-alpha. The release workflow runs on every push to `main` but skips the package as long as `private: true`.

When the rule set stabilizes (target: R01–R05 implemented and validated), unflip:

1. Remove `"private": true` from `packages/cli/package.json`.
2. Configure npm trusted publishing for the package on https://www.npmjs.com (Settings → Publishing access → Add trusted publisher with this repo + workflow).
3. Add a changeset: `pnpm changeset`. Pick the rule set bump and write a one-line summary.
4. Push to `main`. The workflow will open a "Version Packages" PR; merging it triggers the actual `npm publish`.

## License

MIT
