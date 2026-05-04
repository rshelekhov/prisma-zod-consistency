# R01 — Zod ↔ Prisma field drift

**Severity (default):** error
**Phase:** 1 (skill), 2 (CLI subset)
**Surface:** both
**Group:** A (static)

## What it checks

For every model in `schema.prisma`, the corresponding Zod schema(s) must agree with the Prisma definition on:

- **Type compatibility** — `String` ↔ `z.string()`, `Int` ↔ `z.number().int()`, `BigInt` ↔ `z.bigint()`, `Boolean` ↔ `z.boolean()`, `DateTime` ↔ `z.date()`/`z.coerce.date()`, etc.
- **Constraint propagation** — `@db.VarChar(N)` requires `.max(N)` on the Zod side; `@unique` on an email column suggests `.email()`; `Int` requires `.int()`.
- **Required vs optional** — Prisma `String?` ↔ Zod `.nullable()`/`.optional()` (see also R04).

The rule has three sub-modes selected automatically by the discovery phase.

### R01a — hand-written Zod only

When the project has **no Zod-generating Prisma generator** (no `zod-prisma-types`, `prisma-zod-generator`, or `zod-prisma`), every Zod schema in the project is compared directly to its corresponding Prisma model. This is the strictest mode and the most common drift hotspot.

### R01b — generated Zod only

When the project uses a Zod generator and there are no hand-written overrides, R01 sanity-checks the generator configuration against the Prisma schema. Examples: missing `addInputTypeValidation`, custom `@zod` annotations that contradict Prisma constraints.

### R01c — generated + custom (hybrid)

When both generated and hand-written Zod schemas exist, custom schemas must not **weaken** the generated ones. Allowed: `.partial()`, `.omit()`, `.extend()` (with stricter rules), `.pick()`. Flagged: `.passthrough()`, removing required fields without `.partial()`, replacing `.email()` with `.string()`, removing `.max()` constraints.

## Why it matters

Drift between the database schema and the validation layer produces real bugs:

- A `@db.VarChar(100)` column with no `.max(100)` in Zod accepts a 500-character string at the API boundary, then throws a Postgres error at insert time — surfacing as a 500 to the user.
- A `String?` column with a Zod schema that has neither `.nullable()` nor `.optional()` rejects valid `null` reads from the database when parsing API responses.
- A field renamed in `schema.prisma` but still referenced in Zod produces a runtime `undefined` for every consumer.

## How to fix

The skill suggests the specific change inline (e.g. "add `.max(100)` to `Contact.name`"). The CLI in `--fix` mode (Phase 1.8) applies the safe subset automatically: tightening Zod toward Prisma. Schema-side fixes are never automatic.

## Examples

### Bad (R01a — missing constraint)

```prisma
model User {
  id    String @id @default(cuid())
  email String @unique @db.VarChar(255)
}
```

```typescript
// schemas/user.ts
export const userSchema = z.object({
  id: z.string(),
  email: z.string(), // ❌ no .max(255), no .email()
});
```

### Good (R01a)

```typescript
export const userSchema = z.object({
  id: z.string(),
  email: z.string().email().max(255),
});
```

### Bad (R01c — custom weakens generated)

```typescript
import { UserSchema } from "./generated/zod";

// ❌ .passthrough() defeats the validator; unknown keys flow into prisma.create()
export const createUserInputSchema = UserSchema.passthrough();
```

### Good (R01c)

```typescript
import { UserSchema } from "./generated/zod";

export const createUserInputSchema = UserSchema.pick({
  name: true,
  email: true,
}).extend({
  acceptedTos: z.literal(true),
});
```

## Configuration

```jsonc
{
  "R01": {
    "severity": "error",
    "modes": ["R01a", "R01b", "R01c"],     // override auto-detection
    "ignoreModels": ["AuditLog"],          // models to skip entirely
    "knownGenerators": [                   // extend the recognized generator list
      "zod-prisma-types",
      "prisma-zod-generator",
      "zod-prisma"
    ]
  }
}
```

## See also

- R03 — Enum sync (special case of type compatibility for enums)
- R04 — Nullability mismatch (split out for severity granularity)
