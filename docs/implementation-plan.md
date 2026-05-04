# Implementation plan (public roadmap)

The phased roadmap for `prisma-zod-consistency`. Subject to change as real-world usage exposes which checks pull their weight and which don't.

## Phases

| Phase | Name | What ships |
|---|---|---|
| 1 | Skill MVP — Group A (static) | Claude Code SKILL.md + Codex AGENTS.md, full content for R01–R06, real reports against real codebases |
| 1.5 | Skill DB mode — Group B | `--mode db-audit`, R07–R09, requires Postgres MCP or DATABASE_URL |
| 1.7 | Skill patterns mode — Group C | `--mode patterns`, R10–R11, off by default |
| 1.8 | Auto-fix subset (`pz-fix --apply`) | Tightening Zod toward Prisma; never modifies `schema.prisma` |
| 2 | CLI MVP | `pz-check` for the deterministic subset (R01a/R01b, R02, R03, R04, R05 if framework configured) |
| 2.5 | CLI DB mode + SARIF | `pz-check --db`, SARIF 2.1.0 output for GitHub Code Scanning |

## Rule catalogue

See [`packages/checks/`](../packages/checks/) for the full list and per-rule specs.

| ID | Rule | Severity | Phase | Surface |
|---|---|---|---|---|
| R01 | Zod ↔ Prisma field drift | error | 1 | both |
| R02 | `@relation` without explicit `onDelete`/`onUpdate` | warning | 1 | both |
| R03 | Enum sync between Prisma and Zod | error | 1 | both |
| R04 | Nullability mismatch | error | 1 | both |
| R05 | API boundary bypass | warning | 1 | both |
| R06 | Missing index for `where`/`orderBy` (contextual) | info | 1 | skill |
| R07 | Redundant indexes | info | 1.5 | skill |
| R08 | Unused indexes | info | 1.5 | skill |
| R09 | Schema drift vs live DB | warning | 1.5 | skill |
| R10 | N+1 queries | info | 1.7 | skill |
| R11 | `select: { id: true }` for existence checks | info | 1.7 | skill |

## Non-goals (for now)

- MySQL / SQLite / SQL Server / MongoDB support — Phase 1 is Postgres-only by design. The dialect abstraction is in the rule API, but only Postgres has a real implementation.
- ESLint / Biome plugin wrappers — standalone CLI is the priority; plugins can come later.
- Support for `drizzle-zod`, `valibot`, `effect-schema` — first release is Prisma + Zod only.
- Auto-fix for schema-side changes (`@@index` injection, `onDelete` policy choice) — these all imply migrations and are explicitly out of scope.
