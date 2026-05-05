# R01 — Zod ↔ Prisma field drift

| Field | Value |
|---|---|
| Severity (default) | error (R01a, R01c-passthrough); warning (R01b, R01c-nonstrict) |
| Phase | 1 (skill), 2 (CLI) |
| Surface | CLI + skill |
| Group | A (static) |
| Auto-fix | partial — `.max(N)`, `.int()`, looser `.max(M)` (R01a only) |
| Implementation | full — R01a, R01b, R01c all live in CLI |

## What it checks

For every model in `schema.prisma`, the corresponding Zod schema(s) must agree with the Prisma definition on:

- **Type compatibility** — `String` ↔ `z.string()`, `Int` ↔ `z.number().int()`, `BigInt` ↔ `z.bigint()`, `Boolean` ↔ `z.boolean()`, `DateTime` ↔ `z.date()`/`z.coerce.date()`, etc.
- **Constraint propagation** — `@db.VarChar(N)` requires `.max(N)` on the Zod side; `@unique` on an email column suggests `.email()`; `Int` requires `.int()`.
- **Required vs optional** — Prisma `String?` ↔ Zod `.nullable()`/`.optional()` (see also R04).

R01 has three sub-modes. Unlike many static analysis tools that pick one mode per project, the dispatch here is **per-schema**: each Zod schema declaration in the codebase is classified individually. A single file can legitimately host both an R01a schema and an R01c schema side by side, and the rule treats each according to its own form. See "Implementation notes" below for the rationale.

### R01a — hand-written `z.object({...})`

Any schema whose initializer starts with `z.object({...})` (or `z.enum(...)` / `z.nativeEnum(...)`) is compared directly to the matching Prisma model by [name match](../../cli/src/zod/match.ts). This works the same whether or not a Zod generator is configured — local hand-written schemas alongside generated output are still treated as R01a.

### R01b — generator output ↔ Prisma sanity check

Every schema declared **inside the configured generator `outputDir`** is compared to its corresponding Prisma model using the same field-walk as R01a. The intent is different: this isn't drift the user introduced, it's drift in the generator's *output* — typically caused by a misconfigured `@zod.string.max(N)` annotation in `schema.prisma`, a stale generator version, or a forgotten `prisma generate` after widening a column.

R01b findings default to **warning** severity and never carry mechanical `pz-fix` edits — the user can't auto-edit a regenerated file. The actionable change lives in the generator config or in `schema.prisma` itself, and the suggestion text points there. Override with `R01.severity: "error"` in config to gate CI on generator-config drift.

The first-class generator is `zod-prisma-types` (`<Model>Schema` naming convention). `prisma-zod-generator` and `zod-prisma` are detected best-effort by their alternative model-schema naming.

### R01c — derived hand-written schemas weakening generated

Any chain rooted at a non-`z` identifier (`UserSchema.passthrough()`, `UserSchema.pick({...}).extend({...})`, etc.) where the **base identifier resolves into the generator `outputDir`** — directly or transitively through any number of barrel re-exports and `import { X as Y }` aliases — is checked for weakening calls.

Currently flagged:

- `.passthrough()` — defeats the validator entirely; unknown keys flow into `prisma.create()`. Severity: **error**.
- `.nonstrict()` — alias for permissive parsing in older Zod releases. Severity: **warning**.

Allowed (intentional narrowing, never flagged):

- `.partial()`, `.pick({...})`, `.omit({...})`
- `.extend({...})` (the result is structurally stricter even when fields overlap)
- `.refine(...)`, `.transform(...)`, `.pipe(...)`, `.brand()`, `.describe(...)`, `.default(...)`, `.catch(...)`

Note that **per-field `.email()` → `.string()` replacements inside `.extend({...})`** and equivalent re-narrowings are not yet detected — that requires diffing the inside of the extend payload against the generator's emitted shape, and is tracked as a follow-up. The single highest-value finding (`.passthrough()`) is in scope today.

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

- **Per-schema dispatch, not per-project.** Each Zod schema is independently classified as R01a / R01b / R01c / skip based on the *form* of its initializer expression and the *origin* of the identifiers it references. A single file can hold `userPublicSchema = z.object({...})` (R01a) and `createUserSchema = UserSchema.passthrough()` (R01c) side by side, and each finding is attributed to the right sub-mode. The alternative — picking one mode for the whole project — fails on real hybrid codebases where both patterns coexist.
- **Path-based identifier resolution with transitive re-exports.** R01c does not rely on naming conventions to decide whether a derived chain bottoms out in generator output. It uses ts-morph's symbol alias chain, which transparently traverses `import { X as Y }`, `export { X } from "./..."`, and `export * from "./..."`. A `.passthrough()` reached through three barrels is still caught. Naming-based detection was rejected because it (a) gives false positives in hand-written projects with similar naming, and (b) misses generators with different naming conventions.
- **Known limitations.** Dynamic CJS re-exports (`module.exports = { ...require(...) }`) are not resolved — TypeScript's symbol resolution doesn't see them. R01c also doesn't yet diff the inside of `.extend({...})` payloads to detect per-field weakening (e.g. replacing a generated `.email()` with a plain `.string()`); the immediate value is in catching `.passthrough()`.
- **R01b severity default.** Findings on generator output default to `warning`, not `error`, because much of what they flag is intentional generator config (`@zod.string.max(N)` set deliberately tighter than the column). When stricter gating is desired, set `R01.severity: "error"` in config.
- **Source location.** Field-level findings point at the Zod field's line. The `@db.*` constraint side is reported as "from Prisma" in the message but does not link to a `schema.prisma` line — `@mrleebo/prisma-ast` doesn't expose source positions on attributes by default.
- **Codemod insertion order (R01a only).** When the Zod chain already contains a `.nullable()` / `.optional()` / `.nullish()` modifier, `pz-fix` inserts new constraints (`.int()`, `.max(N)`) **before** that modifier, producing `z.number().int().nullable()` rather than `z.number().nullable().int()`. The semantic outcome is the same in current Zod, but the canonical order keeps the value-shape constraints adjacent to the base type. R01b never emits fixes (regenerated file) and R01c does not (the right replacement for `.passthrough()` is intent-dependent).
- **Array element types.** When a Prisma field is `String[]` and the Zod schema is `z.array(...)`, the rule confirms shape compatibility but does NOT recurse into the inner element type. So `String[] ↔ z.array(z.number())` would slip through. Tracked.
- **Enum-typed Prisma fields.** Skipped here, handled by R03.
- **Nullability.** Skipped here, handled by R04.

## See also

- R03 — Enum sync (special case of type compatibility for enums)
- R04 — Nullability mismatch (split out for severity granularity)
