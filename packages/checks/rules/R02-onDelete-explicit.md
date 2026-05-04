# R02 — `@relation` without explicit `onDelete`/`onUpdate`

| Field | Value |
|---|---|
| Severity (default) | warning |
| Phase | 1 (skill), 2 (CLI) |
| Surface | CLI + skill |
| Group | A (static) |
| Auto-fix | no — the right action depends on data-model intent |
| Implementation | done |

## What it checks

Every `@relation` declaration in `schema.prisma` must specify both `onDelete` and `onUpdate` explicitly. Implicit defaults vary across Prisma versions and across referential action support per database, which makes the runtime behavior of cascading deletes hard to predict from reading the schema alone.

The CLI flags any `@relation(fields: [...], references: [...])` declaration that does not include both `onDelete:` and `onUpdate:`.

## Why it matters

- The default `onDelete` action depends on the field's required/optional status (`Restrict` for required, `SetNull` for optional in modern Prisma — but this changed historically).
- A developer reading `schema.prisma` cannot tell what happens to children when a parent is deleted without external knowledge.
- Forgetting `onDelete: Cascade` on a tenant-scoped relation leaves orphaned rows that may leak across tenants.
- Setting `onDelete: Cascade` accidentally on a high-cardinality relation can silently delete millions of rows in a single transaction.

Forcing every relation to be explicit makes the cascade behavior part of the code review, not a post-hoc discovery.

## How to fix

Pick the action that matches your data model intent and add it explicitly:

| Intent | `onDelete` | `onUpdate` |
|---|---|---|
| Block deletion of parent if children exist | `Restrict` | `Restrict` |
| Cascade deletion to children | `Cascade` | `Cascade` |
| Null out the FK on children | `SetNull` (FK must be optional) | `SetNull` |
| Use the column default | `SetDefault` | `SetDefault` |

When the choice is non-obvious, the skill mode of this rule analyzes the surrounding service-layer code to recommend an action; the CLI only flags the absence.

## Examples

### Bad

```prisma
model Conversation {
  id        String    @id @default(cuid())
  contactId String
  contact   Contact   @relation(fields: [contactId], references: [id])
}
```

### Good

```prisma
model Conversation {
  id        String    @id @default(cuid())
  contactId String
  contact   Contact   @relation(
    fields: [contactId],
    references: [id],
    onDelete: Cascade,
    onUpdate: Cascade
  )
}
```

## Configuration

```jsonc
{
  "R02": {
    "severity": "warning",
    "requireOnUpdate": false,            // default; set to true if your team wants onUpdate explicit too
    "ignoreModels": ["AuditLog"],
    "ignoreRelations": [                  // skip specific relations by "Model.field"
      "User.organization"
    ]
  }
}
```

Defaults explained: `onDelete` is required because cascade-on-delete is a data-loss-class decision. `onUpdate` is opt-in because mutating primary keys is exotic — most projects never do it, so requiring it produces noise on codebases that are otherwise diligent about `onDelete`.

## Common false positives

- **None in well-tuned config.** With the defaults (`requireOnUpdate: false`), this rule fires only when `onDelete` is genuinely absent, which is always worth a moment of consideration even if the answer is "Restrict". The smoke run on llc_backoffice produced 3 findings, all real.
- **With `requireOnUpdate: true`, expect noise on PK-immutable codebases.** If your team never updates primary keys (the common case), every `@relation` looks "missing onUpdate" — that's noise, not a bug. Keep the default off.
- **Inverse relation side (the one without `fields:`)** never gets flagged because referential actions only live on the FK-owning side. The rule correctly excludes those.

## Implementation notes

- **Source location.** `@mrleebo/prisma-ast` does not surface source ranges on attribute nodes, so the rule falls back to a token scan: it parses model line ranges directly from the source text and locates the field declaration line by name. Findings now point at the correct `field @relation(...)` line; if the scan fails for any reason (highly unusual), the rule defaults to line 1 rather than crashing.
- **Polymorphic relations / explicit join models** are flagged like any other relation. Usually you want explicit `onDelete` on those too, so this is the right behavior.

## See also

- R01 — Zod ↔ Prisma field drift
