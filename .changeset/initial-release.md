---
"prisma-zod-consistency": minor
---

Initial public release of the `prisma-zod-consistency` CLI.

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
