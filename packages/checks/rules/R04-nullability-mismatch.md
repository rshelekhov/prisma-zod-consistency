# R04 — Nullability mismatch

| Field | Value |
|---|---|
| Severity (default) | error |
| Phase | 1 (skill), 2 (CLI) |
| Surface | CLI + skill |
| Group | A (static) |
| Auto-fix | no — direction depends on schema purpose (DTO vs input) |
| Implementation | done |

## What it checks

For every Zod object schema matched to a Prisma model, walks fields that exist on both sides and compares nullability semantics. Two asymmetric checks:

- **Direction A — Prisma optional, Zod strict.** Prisma `String?` (or any optional column) but the Zod field has none of `.nullable()`, `.optional()`, `.nullish()`, or `.default(...)`. The DB can return `null` for that column; Zod will fail to parse the response.
- **Direction B — Prisma required, Zod accepts null.** Prisma `String` (required) but the Zod field is `.nullable()` or `.nullish()`. The API will accept `null` from a client; Prisma will reject it on `create`/`update` and produce a 500.

`.optional()` on a required Prisma field is intentionally NOT flagged — that's the standard PATCH idiom (the input may omit the key, in which case Prisma keeps the existing value). Same for `.default(value)` — the default fills in for missing input.

Array fields (`String[]`) are skipped. Postgres treats array columns as nullable at the SQL level by default; the Prisma client hides this by always returning `[]` on read. Flagging would always be a false positive.

## Why it matters

Both directions cause real production bugs:

- **Direction A** surfaces as a parse error when reading from the DB. If your code does `userSchema.parse(await prisma.user.findUnique(...))` (a common idiom for sanitizing the boundary), every row with a NULL in that column will throw. Often missed in dev because the dev seed data doesn't have NULLs.
- **Direction B** surfaces as a 500 on the next deploy. The API accepts a request with `null`, the service hands it to `prisma.X.create({ data })`, Postgres rejects with a NOT NULL constraint violation. The Zod layer was supposed to be the contract; it isn't holding.

## How to fix

- **Direction A** — add `.nullable()` if the schema represents a DB read (where NULL is a valid value), or `.optional()` if it represents an input that may omit the key (e.g. a PATCH body), or `.nullish()` if both apply.
- **Direction B** — remove `.nullable()` / `.nullish()`. If you actually want to accept `null` as a sentinel for "clear this value", that's a write-side semantic Prisma doesn't help with — handle it in the service layer.

No auto-fix because direction A's right answer (`.nullable` vs `.optional` vs `.nullish`) depends on the schema's purpose, which the CLI can't infer.

## Examples

### Bad — Direction A (Prisma optional, Zod strict)

```prisma
model User {
  id   String  @id @default(cuid())
  name String?
}
```

```typescript
export const userSchema = z.object({
  id: z.string(),
  name: z.string(), // ❌ DB returns null for users with no name → parse error
});
```

### Bad — Direction B (Prisma required, Zod nullable)

```prisma
model User {
  id    String @id @default(cuid())
  email String                         // required
}
```

```typescript
export const createUserSchema = z.object({
  email: z.string().nullable(), // ❌ API accepts null, Prisma rejects → 500
});
```

### Good

```typescript
export const userSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
});

export const createUserSchema = z.object({
  email: z.string(),
});
```

### Ambiguous — flagged but often intentional

```typescript
// Prisma User.email is required.
// Zod uses .optional() for a PATCH endpoint where omitting "email"
// means "leave existing value untouched". Not flagged by R04
// (.optional() on required Prisma is allowed). ✓
export const updateUserSchema = z.object({
  email: z.string().optional(),
});
```

```typescript
// Required-create + optional-on-update is standard. The matcher pairs both
// `createUserSchema` and `updateUserSchema` with the User model. R04 sees:
//   - createUserSchema.email: required ↔ Prisma required → ok
//   - updateUserSchema.email: optional ↔ Prisma required → ok (.optional() is allowed)
```

## Configuration

```jsonc
{
  "R04": {
    "severity": "error",
    "ignoreModels": ["AuditLog"],
    "ignoreSchemaSuffixes": ["Update", "Patch"]
  }
}
```

`ignoreSchemaSuffixes`: skip schemas whose name ends with one of these. Useful when your team relaxes nullability everywhere in Update/Patch shapes and you don't want the noise. Be careful — this also disables direction-A checks for those schemas, which can hide real bugs in PATCH responses.

## Suppression

R04 findings inside TS/TSX source files can be silenced inline with comment directives. The most common use case is one-off PATCH endpoints where you've reviewed the nullability divergence and accepted it.

```typescript
// pz-disable-next-line R04
email: z.string().nullable(), // PATCH-style: null means "clear this value"
```

Block form:

```typescript
// pz-disable R04
// ... code that would normally fire R04 ...
// pz-enable R04
```

Wildcards, multi-rule lists, and trailing reasons in `-- ` style are also supported — see [packages/cli/README.md](../../cli/README.md#suppression-comments) for the full grammar.

To hard-gate R04 (no suppression honoured, every finding always reported), set in your config:

```jsonc
{ "R04": { "suppressionsEnabled": false } }
```

## Common false positives

- **PATCH endpoints made permissive intentionally.** Some teams type every field on every Update schema as `.nullable().optional()` regardless of the underlying Prisma column, to allow "set to null", "leave alone", or "set to value". This produces real direction-B findings on the required Prisma fields. If that's your policy, configure `ignoreSchemaSuffixes: ["Update", "Patch"]` and accept that nullability won't be checked there.
- **Computed fields exposed via Zod that have no Prisma backing.** If a Zod schema includes a field that doesn't exist in Prisma (e.g. `totalPaid` computed from joins), it's not flagged at all — the rule only compares fields present on both sides.
- **Json columns**. `Json?` ↔ `z.unknown()` (where `z.unknown()` is non-nullable) is technically direction A. Acceptable in practice because callers usually know to handle the `unknown`/null case. If noisy, exclude the field via `ignoreFields` (planned).

## Implementation notes

- **Array fields are skipped entirely** for nullability comparison (see top of "What it checks"). Column existence is still part of R09.
- **Relations are skipped.** Whether the relation field itself is nullable is a different concern (handled implicitly by R02 via `onDelete: SetNull` requiring an optional FK).
- **No source-level fix proposed.** Future work could heuristic the right answer (`.nullable()` for DTO-shaped schemas based on naming conventions like `*DtoSchema`, `.optional()` for `*InputSchema`/`*UpdateSchema`), but the success rate for that heuristic is low and the failure mode is silent. Stays manual.

## See also

- R01 — Field type drift (orthogonal)
- R09 — Schema drift vs live DB (also flags nullability, but at the column-existence level — Prisma vs actual SQL `NOT NULL`)
