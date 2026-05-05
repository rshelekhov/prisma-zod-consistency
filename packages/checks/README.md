# @prisma-zod-consistency/checks

Source of truth for all `prisma-zod-consistency` rules. The CLI and the skills both consume from here so they never drift.

## Rule format

Every rule lives in `rules/RNN-slug.md` and follows this template:

```markdown
# RNN — Title

| Field | Value |
|---|---|
| Severity (default) | error / warning / info |
| Phase | 1 / 1.5 / 1.7 / 1.8 / 2 |
| Surface | CLI / skill / both |
| Group | A (static) / B (live DB) / C (patterns) |
| Auto-fix | yes / partial / no |
| Implementation | done / partial / stub |

## What it checks
Algorithmic / observable definition. 1–2 paragraphs.

## Why it matters
Concrete failure mode in production. Used by the skill to add context to findings.

## How to fix
By hand and (when applicable) via auto-fix.

## Examples

### Bad
Minimal trigger.

### Good
Fixed version.

### Ambiguous — flagged but often intentional
Cases that look like violations but are usually deliberate. The skill uses these to filter false alarms.

## Configuration
All rule options with defaults and examples.

## Common false positives
When the rule fires but it's usually not a bug. Both the skill and CLI users rely on this.

## Implementation notes
Known limitations, deferred work, important quirks.

## See also
Related rules.
```

## Index

| ID | Rule | Severity (default) | Surface | Auto-fix | Status |
|---|---|---|---|---|---|
| R01 | Zod ↔ Prisma field drift | error | CLI + skill | partial | done (R01a + R01b + R01c) |
| R02 | `@relation` without explicit `onDelete` | warning | CLI + skill | — | done |
| R03 | Enum sync (Prisma ↔ Zod) | error | CLI + skill | partial | done |
| R04 | Nullability mismatch | error | CLI + skill | — | done |
| R05 | API boundary bypass (Hono, tRPC) | warning | CLI + skill | — | done (Hono + tRPC) |
| R06 | Missing index for `where`/`orderBy` (contextual) | info | skill only | — | skill-only by design |
| R07 | Redundant indexes (live DB) | info | CLI `--db` + skill | — | done (Postgres) |
| R08 | Unused indexes (live DB) | info | CLI `--db` + skill | — | done (Postgres) |
| R09 | Schema drift vs live DB | warning | CLI `--db` + skill | — | done (column-level Postgres) |
| R10 | N+1 queries | info | skill only | — | skill-only by design |
| R11 | `select: { id: true }` for existence checks | info | skill only | partial | skill-only by design |

## How the skill consumes these

The Claude Code `SKILL.md` and Codex `AGENTS.md` instruct the agent to read the relevant `rules/RNN-*.md` BEFORE adjudicating any finding. Each section serves a specific purpose:

- **What it checks** — interpret the rule literally; don't improvise the definition
- **Why it matters** — explain to the user why a finding is a real bug, not just repeat the message
- **Examples → Ambiguous** — recognize when a flagged case is the intentional pattern, add a caveat
- **Common false positives** — filter likely-noise findings before presenting them
- **Configuration** — when the user pushes back on noise, suggest the right config knob

This is why every rule (including skill-only R06/R10/R11) ships a full spec — the agent's quality depends on the spec's quality.

## Examples

The `examples/` directory contains `good/` and `bad/` fixtures organized by rule. These are:

1. **Test fixtures for the CLI** — `pnpm test` in `packages/cli` runs each rule against the corresponding `examples/RNN/{good,bad}/` directory.
2. **Concrete reference cases for the skills** — the agent can be pointed at these to ground its understanding of the rule.
