# @prisma-zod-consistency/checks

Source of truth for all `prisma-zod-consistency` rules. The CLI and the skills both consume from here so they never drift.

## Rule format

Every rule lives in `rules/RNN-slug.md` and follows this template:

```markdown
# RNN — Title

**Severity (default):** error | warning | info
**Phase:** Phase number this is implemented in
**Surface:** cli | skill | both
**Group:** A (static) | B (live DB) | C (patterns)

## What it checks
One-paragraph description.

## Why it matters
Concrete failure mode if violated.

## How to fix
Either a short answer or a link to a longer doc.

## Examples

### Bad
\`\`\`prisma
…
\`\`\`

### Good
\`\`\`prisma
…
\`\`\`

## Configuration
Any rule-specific config keys.

## See also
Related rules.
```

## Index

| ID | Rule | Severity | Phase | Surface |
|---|---|---|---|---|
| R01 | Zod ↔ Prisma field drift | error | 1 | both |
| R02 | `@relation` without explicit `onDelete`/`onUpdate` | warning | 1 | both |
| R03 | Enum sync between Prisma and Zod | error | 1 | both |
| R04 | Nullability mismatch | error | 1 | both |
| R05 | API boundary bypass (no Zod validation before Prisma write) | warning | 1 | both |
| R06 | Missing index for `where`/`orderBy` (contextual) | info | 1 | skill |
| R07 | Redundant indexes | info | 1.5 | skill |
| R08 | Unused indexes | info | 1.5 | skill |
| R09 | Schema drift vs live DB | warning | 1.5 | skill |
| R10 | N+1 queries | info | 1.7 | skill |
| R11 | `select: { id: true }` for existence checks | info | 1.7 | skill |

## Examples

The `examples/` directory contains `good/` and `bad/` fixtures organized by rule. These are used as test fixtures by the CLI and as concrete reference cases for the skills.
