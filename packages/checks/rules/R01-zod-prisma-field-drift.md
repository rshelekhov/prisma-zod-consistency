# R01 — Zod ↔ Prisma field drift

| Field | Value |
|---|---|
| Severity (default) | error |
| Phase | 1 (skill), 2 (CLI subset) |
| Surface | CLI + skill |
| Group | A (static) |
| Auto-fix | partial — `.max(N)`, `.int()`, looser `.max(M)` |
| Implementation | partial — R01a only; R01b/R01c deferred |

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

## Suppression

R01 findings inside TS/TSX source files can be silenced inline with comment directives. The syntax mirrors ESLint / Biome / prisma-lint:

```typescript
// pz-disable-next-line R01
email: z.string(), // intentional: legacy column has no max length contract
```

Block form:

```typescript
// pz-disable R01
// ... code that would normally fire R01 ...
// pz-enable R01
```

Wildcards, multi-rule lists, and trailing reasons in `-- ` style are also supported — see [packages/cli/README.md](../../cli/README.md#suppression-comments) for the full grammar.

To hard-gate R01 (no suppression honoured, every finding always reported), set in your config:

```jsonc
{ "R01": { "suppressionsEnabled": false } }
```

## Common false positives

- **DTO schemas that serialize `DateTime` as `string`.** Many projects shape their API responses so dates go over the wire as ISO strings. Prisma still reads them as `Date`, so the comparison `DateTime ↔ z.string()` looks like drift but is intentional. Suggest `z.string().datetime()` (still a string, but format-validated) or `z.coerce.date()` (parsed to Date) — either way the developer chose the trade-off, not a drift.
- **`Json` columns with type-narrowed Zod.** `Json` in Prisma is `unknown` at the type level; teams often write a more specific Zod schema for what they expect to put there. The comparison says "expected `unknown`/`any`/`record`, got `object`" — that's tightening, not drift. Configure `R01.ignoreFields` for those columns or accept the noise.
- **Schemas that intentionally subset the model.** A `createUserSchema` legitimately omits `id`, `createdAt`, `updatedAt`. This rule does not flag *missing* fields — only fields present on both sides that disagree — so this isn't usually a noise source, but if your matcher heuristic pairs the wrong schema (e.g. `userPublicSchema` matched to `User`), you'll see false positives. Add the schema name to `ignoreModels`.
- **Custom Prisma types via `@db.<NativeType>`.** A few exotic types (`Bytes`, `Citext`, `Money`) aren't covered by the type compatibility table. Currently the rule returns no expected type for these and emits no finding — safe, but the type still drifts. Track in implementation notes below.

## Implementation notes

- **Only R01a is implemented today.** R01b and R01c require detecting which symbols are exported from the Zod-generator output dir and checking that custom schemas reference them. Discovery already detects the Zod mode; the comparison logic for hybrid mode lands in a follow-up.
- **Source location.** Field-level findings point at the Zod field's line. The `@db.*` constraint side is reported as "from Prisma" in the message but does not link to a `schema.prisma` line — `@mrleebo/prisma-ast` doesn't expose source positions on attributes by default.
- **Codemod insertion order.** When the Zod chain already contains a `.nullable()` / `.optional()` / `.nullish()` modifier, `pz-fix` inserts new constraints (`.int()`, `.max(N)`) **before** that modifier, producing `z.number().int().nullable()` rather than `z.number().nullable().int()`. The semantic outcome is the same in current Zod, but the canonical order keeps the value-shape constraints adjacent to the base type.
- **Array element types.** When a Prisma field is `String[]` and the Zod schema is `z.array(...)`, the rule confirms shape compatibility but does NOT recurse into the inner element type. So `String[] ↔ z.array(z.number())` would slip through. Tracked.
- **Enum-typed Prisma fields.** Skipped here, handled by R03.
- **Nullability.** Skipped here, handled by R04.

## See also

- R03 — Enum sync (special case of type compatibility for enums)
- R04 — Nullability mismatch (split out for severity granularity)
