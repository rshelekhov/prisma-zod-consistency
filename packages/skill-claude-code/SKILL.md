---
name: prisma-zod-consistency
description: Audit a Prisma + Zod + TypeScript project for drift between the database schema, the validation layer, and the way they're used in code. Triggers when the user asks to "check consistency", "audit prisma and zod", or after meaningful changes to schema.prisma. Reports drift with file:line, severity, and a suggested fix.
---

# prisma-zod-consistency (Claude Code skill)

You are auditing a Prisma + Zod + TypeScript codebase for cross-layer consistency. Findings should be precise, low-noise, and actionable — every finding must point at a specific file:line and propose a concrete fix.

## When to run

- Explicit request: "проверь согласованность", "check Prisma/Zod consistency", "audit my schemas".
- After a meaningful change to `prisma/schema.prisma` (new model, removed field, modified `@db.*`, modified `@relation`, modified `enum`).
- Before a release, as part of a manual checklist.

Do **not** auto-trigger on every Zod schema edit — too noisy.

## Discovery (always first)

Before running any check, build a project profile:

1. Locate `schema.prisma`. Default: `prisma/schema.prisma`. If not present, ask the user.
2. Read the `datasource` block — note the provider (postgresql, mysql, sqlite, …). This determines which Group B checks are available later.
3. Read every `generator` block. If one of these is present, note its `output` directory:
   - `zod-prisma-types`
   - `prisma-zod-generator`
   - `zod-prisma`
4. Locate hand-written Zod schemas. Common locations: `src/schemas/`, `src/validators/`, `src/lib/schemas/`, alongside route files. Find all `*.ts` files that `import { z } from "zod"`.
5. Determine the **Zod mode** for R01:
   - **R01a (hand-written only)** — no Zod generator detected.
   - **R01b (generated only)** — Zod generator detected, no hand-written schemas (rare).
   - **R01c (hybrid)** — both. Custom schemas import from the generated output dir or shadow the same model names.
6. Identify the HTTP layer (Hono / tRPC / Next / Express / Fastify / NestJS) by scanning entry files. Drives R05.

State the discovered profile to the user in one short paragraph before proceeding.

## Default check pass (Group A — static)

Run these in order of value-to-noise ratio:

| Order | Rule | Spec |
|---|---|---|
| 1 | R01 — Zod ↔ Prisma field drift | `../checks/rules/R01-zod-prisma-field-drift.md` |
| 2 | R03 — Enum sync | `../checks/rules/R03-enum-sync.md` |
| 3 | R04 — Nullability mismatch | `../checks/rules/R04-nullability-mismatch.md` |
| 4 | R02 — `@relation` without explicit `onDelete` | `../checks/rules/R02-onDelete-explicit.md` |
| 5 | R05 — API boundary bypass | `../checks/rules/R05-validated-bypass.md` |
| 6 | R06 — Missing index (contextual) | `../checks/rules/R06-missing-index-context.md` |

Read the spec markdown for each rule before flagging anything against it. The spec is the source of truth — if your interpretation diverges, follow the spec.

## Optional modes

- `--mode db-audit` — Group B (R07–R09). Requires Postgres MCP or DATABASE_URL access. Ask the user before running.
- `--mode patterns` — Group C (R10–R11). High false-positive rate. Off by default; only run when the user explicitly asks for pattern review.

## Reporting format

Output a single markdown report with one section per rule that produced findings. Within each section, list findings as:

```
- [error|warning|info] <file>:<line> — <one-sentence message>
  Suggested fix: <one-sentence actionable suggestion>
```

End with a summary line: `<N> errors, <M> warnings, <K> info`.

Do not output a section for rules with zero findings. Do not output a section header if it would be empty.

## When to stop

- After the default check pass completes. Do not chain into Group B/C unless the user asks.
- If you cannot locate `schema.prisma` or the Zod schemas directory, ask the user instead of guessing.
- If a check requires running the user's code (live DB, runtime introspection), ask before doing it.

## What you must not do

- Do not modify the user's files directly. Suggested fixes are advisory; the user applies them.
- Do not invent rule ids. Use only R01–R11 as listed.
- Do not run the CLI's `--fix` mode automatically.
- Do not assume the project's stack — ask if discovery is ambiguous.
