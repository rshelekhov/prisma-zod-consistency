---
"prisma-zod-consistency": minor
---

First-run UX polish ahead of public launch (Marketing MVP #1). All four
fixes are user-visible and target the audit findings in
`first-run-audit-2026-05.md`.

- **Nit #1 — actionable error when the default `schemaPath` is missing.** In a
  monorepo the default `prisma/schema.prisma` rarely exists. The CLI now scans
  the project for `**/schema.prisma` (excluding `node_modules`, `dist`,
  `build`, `.next`, `.turbo`, `.git`, `coverage`, `generated`) and surfaces up
  to 8 candidates in the error message, with a hint to set `schemaPath` in
  `.prismazodrc.json` or pass `--cwd`. When no `.prisma` file exists anywhere,
  the message says so explicitly instead of fabricating candidates.

- **Nit #2 — leaky-bucket fix for "0 Zod schemas matched".** Pre-0.9.0, a
  default-include monorepo run printed `✓ no findings (1 Prisma model, 0 Zod
  schemas, 0 matched)` — green, exit 0 — even though the linter compared
  nothing because the include glob missed `apps/**` and `packages/**`. Now
  this case prints a yellow `⚠ no Zod schemas matched at include paths: [...]`
  with the resolved patterns echoed back, a monorepo hint, and a red
  `✗ 0 schemas matched (lint did not run)` line. **Exit code is now 2** in
  this case (bad invocation), so CI surfaces the misconfig instead of merging
  green. Opt out by disabling the static rules in config:
  `{ "rules": { "R01": { "severity": "off" }, "R03": { "severity": "off" }, "R04": { "severity": "off" } } }`.
  `RunSummary` gains a new `includePaths` field (optional, populated from
  `config.include`).

- **Nit #3 — multi-file schema with no datasource block now explains itself.**
  Pre-0.9.0, pointing `schemaPath` at a directory that has `.prisma` files but
  no `datasource` block (typical when users mistake a `models/` sub-directory
  for the entry) failed with the parser-level `Unsupported or missing
  datasource provider: <none>`. The new error names the loaded files and
  explains that multi-file Prisma schemas (5.15+ `prismaSchemaFolder`) require
  the datasource in the entry file. The single-file case gets a slightly
  different, more targeted variant.

- **Nit #4 — R03 inline `z.enum([...])` finding now reports the parent schema
  in `scope.model`.** Pre-0.9.0, an inline `role: z.enum([...])` field inside
  `UserSchema` produced `scope: { model: "role" }` (the field name as model)
  with no `field` key — wrong on both axes. JSON / SARIF consumers now get
  `scope: { model: "UserSchema", field: "role" }`. Top-level standalone enum
  schemas (`export const ZRole = z.enum([...])`) keep their existing scope
  (`{ model: "ZRole" }`).

The README at the repo root is rewritten with a 5-second pitch, a Quick start
block, three concrete "what it catches" examples sourced from open-source
smoke runs (`dub`, `documenso`, `formbricks`), and a CI snippet — replacing
the prior status-and-monorepo overview that was effectively invisible to a
first-time visitor.
