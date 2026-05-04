---
name: prisma-zod-consistency
description: Audit a Prisma + Zod + TypeScript project for cross-layer drift between the database schema, the Zod validation layer, and how they're used in route handlers. Triggers on explicit requests to "check Prisma/Zod consistency", "audit my schemas", or after meaningful changes to schema.prisma. Combines the deterministic CLI (prisma-zod-consistency / pz-check) with contextual analysis of service code, suggested fixes, and optional auto-fix.
---

# prisma-zod-consistency (Claude Code skill)

You audit Prisma + Zod + TypeScript codebases for cross-layer consistency. The deterministic part runs through the `prisma-zod-consistency` CLI; the contextual part — interpreting findings, recommending which to fix, scanning service code for index opportunities — is yours.

## When to engage

Engage when the user:

- Explicitly asks to "check consistency", "audit Prisma/Zod", "проверь согласованность".
- Has changed `prisma/schema.prisma` (new model, removed/renamed field, modified `@db.*`, modified `@relation`, modified `enum`) and asks for review.
- Is doing a release-readiness pass.

Do NOT auto-engage on every Zod schema edit — too noisy.

## Step 1 — Discovery (always first)

Read the project's basic shape and report it back to the user in one short paragraph BEFORE running anything.

1. `prisma/schema.prisma` exists? If not, ask the user where it is.
2. Datasource provider (`postgresql`, `mysql`, `sqlite`, ...). Determines whether Group B (live DB) checks are available later.
3. Generator blocks. Note any of `zod-prisma-types`, `prisma-zod-generator`, `zod-prisma`. Their presence puts you in **R01b/R01c mode** (custom Zod augments generated). Absence puts you in **R01a mode** (custom Zod compared directly to Prisma).
4. Hand-written Zod schemas. Find files with `import { z } from "zod"` outside any generator output dir.
5. HTTP layer (Hono, tRPC, Next, Express, Fastify). Drives R05.

State the discovered profile in one paragraph, then ask the user whether to proceed with the default check pass (don't surprise them with a long report).

## Step 2 — Run the CLI

The CLI does the deterministic Group A static analysis. Always prefer the CLI over manual inspection — it's faster and won't miss edge cases.

```bash
# JSON output for programmatic parsing:
prisma-zod-consistency --rules R01,R02,R03,R04,R05 --output json --cwd <project-root>
# (alias: pz-check)
```

Parse the JSON. The shape is:

```jsonc
{
  "schemaVersion": 1,
  "findings": [
    {
      "ruleId": "R01" | "R02" | "R03" | "R04" | "R05",
      "severity": "error" | "warning" | "info",
      "message": "...",
      "location": { "file": "abs/path", "line": 42 },
      "suggestion": "...",          // optional
      "fix": { "description": "..." }, // present iff auto-fixable
      "scope": { "model": "...", "field": "...", "relation": "..." }
    }
  ],
  "summary": { "total": N, "error": N, "warning": N, "info": N }
}
```

If the CLI is not installed in the project: suggest `pnpm add -D prisma-zod-consistency` (when published), or run via the global path the user already has it at, or via npx if applicable.

## Step 3 — Report findings (with context)

Group findings by rule. For EACH rule with findings, write a brief section in this shape:

```
### R01 — Zod ↔ Prisma field drift (4 findings, all error)

Each one is a real drift that produces runtime errors:

- `bookingCategory.ts:35` — `createdAt` is `DateTime` in Prisma but `z.string()` in `bookingCategoryDtoSchema`.
  This is likely intentional (DTOs serialize Date as ISO string for JSON). If so, change to `z.string().datetime()` so the format is at least validated. If not, use `z.coerce.date()` so DB reads parse correctly.
- `communication.ts:21` — `size` is `Int` without `.int()`. Easy auto-fix.
- ...
```

Add 1-2 sentences of CONTEXT per finding when you can — not just repeating the message. The user can read the message themselves.

For findings the CLI flagged but you can see are intentional given the surrounding code, say so explicitly: "Flagged but intentional — `createInvoiceSchema.bookingId` is required at create time even though Prisma allows null, because the booking is attached later in a separate step. Suppress in `.prismazodrc`."

## Step 4 — Offer the auto-fix

If the CLI returned any findings with a `fix` field present, ALWAYS surface the auto-fix option:

```
3 of these findings are auto-fixable. To preview:

  prisma-zod-consistency fix --rules R01,R03

To apply:

  prisma-zod-consistency fix --rules R01,R03 --apply
```

Do NOT run the fix yourself unless the user explicitly asks ("apply the fixes", "go ahead and fix").

## Step 5 — R06 contextual analysis (optional, only if requested)

R06 (missing index for `where`/`orderBy`) is intentionally NOT implemented in the CLI — it requires context the CLI cannot judge. If the user asks "are there missing indexes?":

1. Read service-layer files (`src/services/`, `src/repositories/`, or wherever `prisma.*` calls live).
2. For each `prisma.X.findMany`, `findFirst`, `update`, `delete` with a `where:` clause, check what columns are being filtered/sorted on.
3. Cross-reference with `@@index` and field-level `@unique` declarations in `schema.prisma`.
4. Recommend an index ONLY when the call site looks hot (lives inside a request handler, not a one-off script). Skip cold paths and migrations.

Report missing indexes as a separate section, with each recommendation including:
- The model and column(s).
- The exact `@@index([...])` line to add.
- A 1-sentence justification ("filtered in `getConversationsForUser`, runs on every page load").

## Step 6 — Optional modes

- **db-audit (Group B, R07–R09)**: requires Postgres MCP or `DATABASE_URL`. Ask the user before running. Currently NOT in the CLI — coming in Phase 1.5.
- **patterns (Group C, R10–R11)**: N+1 detection, `select: { id: true }` for existence checks. High false-positive rate. Off by default; only run when the user explicitly asks for pattern review.

## Reporting format

Output ONE markdown report. Structure:

1. **Discovery** — one paragraph from Step 1.
2. **Findings** — one section per rule with non-zero findings (Step 3).
3. **Auto-fix offer** — one line if any fixes are available (Step 4).
4. **Summary** — count by severity at the end.

Do not output sections with zero findings. Do not write a "no issues found in R02" paragraph — silence is fine.

## Rule references

Full per-rule specs (read these before adjudicating edge cases):

- `../checks/rules/R01-zod-prisma-field-drift.md`
- `../checks/rules/R02-onDelete-explicit.md`
- `../checks/rules/R03-enum-sync.md`
- `../checks/rules/R04-nullability-mismatch.md`
- `../checks/rules/R05-validated-bypass.md`
- `../checks/rules/R06-missing-index-context.md`

## Constraints

- Do not modify the user's files directly. Suggested fixes are advisory; auto-fix only via the user explicitly invoking `pz-fix --apply`.
- Do not invent rule ids beyond R01–R11.
- Do not run the CLI's `--apply` mode automatically.
- When discovery is ambiguous, ask the user — don't guess.
- If the CLI is unavailable and the user can't install it, you can still run R02/R03 manually by reading `schema.prisma` and the Zod files yourself, but say so explicitly so the user knows the analysis is partial.
