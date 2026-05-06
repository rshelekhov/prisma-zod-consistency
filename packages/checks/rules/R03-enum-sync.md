# R03 — Enum sync between Prisma and Zod

| Field | Value |
|---|---|
| Severity (default) | error |
| Phase | 1 (skill), 2 (CLI) |
| Surface | CLI + skill |
| Group | A (static) |
| Auto-fix | partial — replace base call with `z.nativeEnum(EnumName)` and add the import. Enum value mismatches are NOT auto-fixed (removing a value can break compile-time references elsewhere). |
| Implementation | done |

## What it checks

For every enum declared in `schema.prisma`, every Zod schema referencing it must include exactly the same set of values. The rule covers three patterns:

- **`z.nativeEnum(PrismaEnum)`** — type-safe by construction; the rule still verifies that the imported symbol matches the expected Prisma enum and is not aliased to something else.
- **`z.enum(['VALUE_1', 'VALUE_2'])`** — value literals; the rule does a set comparison against the Prisma enum and flags any missing or extra values.
- **`z.enum(PrismaEnum)`** (Zod 4 native-enum shorthand) — the rule resolves the identifier through ts-morph (TS `enum X` declarations and `const X = {...} as const` literals), then either compares the resolved values to the Prisma enum or — when TS-side resolution can't reach the declaration — accepts the binding by name match against the Prisma registry. When neither resolution path succeeds, the rule emits an `info`-level note rather than asserting drift.

Mismatches are reported per direction: values in Prisma but not in Zod, and values in Zod but not in Prisma.

## Why it matters

Enums encode a finite set of allowed states. When the two sides disagree:

- A new value added to the Prisma enum but missed in Zod silently rejects valid data at the API boundary, producing 400s for what should be valid input.
- A value removed from Prisma but still present in Zod allows the API to accept an input that the database will then reject, producing 500s.
- The TypeScript compiler does not catch literal-array drift in `z.enum([...])` because the generic is inferred from the array, not from a shared source.

Keeping enums in sync is one of the highest-value, lowest-noise checks in the suite.

## How to fix

When both sides exist:

- Prefer `z.nativeEnum(PrismaEnum)` over `z.enum([...])` — it eliminates the drift risk by deriving the values from the imported Prisma type.
- If you must use `z.enum([...])` (e.g. you want a subset), document why and pin the values explicitly.

The skill suggests the fix inline (which values to add/remove). The CLI in `--fix` mode (Phase 1.8) does **not** auto-modify enums — silently removing a value can break compile-time references in unrelated code.

## Examples

### Bad — missing value in Zod

```prisma
enum BookingStatus {
  DRAFT
  CONFIRMED
  CANCELLED
  COMPLETED
}
```

```typescript
// schemas/booking.ts
export const bookingStatusSchema = z.enum([
  "DRAFT",
  "CONFIRMED",
  "CANCELLED",
  // ❌ COMPLETED missing
]);
```

### Bad — extra value in Zod

```typescript
export const bookingStatusSchema = z.enum([
  "DRAFT",
  "CONFIRMED",
  "CANCELLED",
  "COMPLETED",
  "REFUNDED", // ❌ not in Prisma enum
]);
```

### Good — single source of truth via `nativeEnum`

```typescript
import { BookingStatus } from "@prisma/client";

export const bookingStatusSchema = z.nativeEnum(BookingStatus);
```

### Good — explicit subset, intentionally narrow

```typescript
import { BookingStatus } from "@prisma/client";

// Only statuses a manager is allowed to set manually.
export const managerSettableStatusSchema = z.enum([
  BookingStatus.CONFIRMED,
  BookingStatus.CANCELLED,
] as const);
```

## Configuration

```jsonc
{
  "R03": {
    "severity": "error",
    "preferNativeEnum": true,            // also flag z.enum([...]) when nativeEnum would work
    "ignoreEnums": []                    // skip specific Prisma enums by name
  }
}
```

## Suppression

R03 findings inside TS/TSX source files can be silenced inline with comment directives. Useful when a `z.string()` field is intentionally untyped against a Prisma enum (legacy DTO shape, public-API stability, etc.).

```typescript
// pz-disable-next-line R03
status: z.string(), // legacy public API — enum drift acknowledged
```

Block form:

```typescript
// pz-disable R03
// ... code that would normally fire R03 ...
// pz-enable R03
```

Wildcards, multi-rule lists, and trailing reasons in `-- ` style are also supported — see [packages/cli/README.md](../../cli/README.md#suppression-comments) for the full grammar.

To hard-gate R03 (no suppression honoured, every finding always reported), set in your config:

```jsonc
{ "R03": { "suppressionsEnabled": false } }
```

## Common false positives

- **`z.string()` instead of enum is *sometimes* intentional.** If a DTO is meant to be public-API-consumable and the team prefers permissive typing on the wire (because enum values may evolve and they don't want every consumer to break on a new value), they may type the field as `z.string()` deliberately. This is unusual but happens. Acceptable but should be documented; flagging it as `info` rather than `error` is a config option.
- **Top-level `userRoleSchema = z.enum(["admin", "manager"])`** when Prisma has `enum UserRole { ADMIN MANAGER }` — case mismatch is almost always a real bug (Prisma is case-sensitive), not a stylistic choice. Worth flagging hard.
- **Subset enum schemas** (intentionally narrower than Prisma's). E.g. a `managerSettableStatusSchema = z.enum([BookingStatus.CONFIRMED, BookingStatus.CANCELLED])` for a UI control that only allows two of the four states. These DO get flagged as "missing values". Add their schema names to `ignoreEnums` (or reference the Prisma enum members like in the example, which uses the imported symbols and avoids the literal-string drift entirely).
- **Case-insensitive coerce idiom.** A common pattern for query-string-friendly enum inputs is `z.string().transform((v) => v.toUpperCase()).pipe(z.nativeEnum(Foo))` (or `.pipe(fooSchema)` where `fooSchema = z.nativeEnum(Foo)`). The chain is **already correct** — it accepts mixed-case input but constrains the parsed value to the enum. R03 detects both forms and skips the finding, so this is no longer flagged.

## Implementation notes

- **Zod 4 `z.enum(IDENT)` resolution (0.8.0).** Three-step ladder: (1) ts-morph alias chain → resolve to `enum X` or `const X = {...} as const` declaration. (2) name match against the Prisma registry — covers the common case of `import { Foo } from "@prisma/client"` where the `.d.ts` isn't in the parse. (3) info-level note when neither resolves. This unblocks Zod 4 codebases that previously generated 97% false-positive R03 findings (smoke baseline on dub: 38 findings, 1 true positive).
- **Field-level matching.** The rule walks Zod object schemas matched to Prisma models (via the same `matchSchemasToModels` heuristic R01/R04 use). For each Prisma field whose type is an enum, it looks for the same-named Zod field and checks that the Zod side is `z.enum`/`z.nativeEnum` with matching values.
- **Pipe-chain detection.** Before flagging a base type like `z.string()` for an enum-typed Prisma field, the rule walks the chain looking for `.pipe(z.nativeEnum(<ExpectedEnum>))`, `.pipe(z.enum(...))`, or `.pipe(<knownEnumSchema>)` where `<knownEnumSchema>` is a project-local Zod schema bound to the matching Prisma enum. Any of those is sufficient evidence the chain is already correct — the finding is suppressed. This keeps the codemod from breaking case-insensitive coerce idioms (see "Common false positives").
- **Auto-fix scope.** Only the base call (`z.string()` → `z.nativeEnum(EnumName)`) is auto-fixed. Trailing modifiers like `.nullable()`, `.optional()`, `.default(...)` are preserved.
- **Auto-fix import management.** The fix scans the first ~80 lines of the file for an existing import naming the target enum. If the symbol is already in scope, no import edit is emitted. Otherwise the fix tries to **extend the existing `import { ... } from "@prisma/client"`** (single-line or multi-line, with or without trailing comma) rather than adding a second import line. Only when there is no `@prisma/client` import at all does the fix prepend a fresh `import { X } from "@prisma/client";`.
- **`z.nativeEnum` identifier check.** The rule trusts the imported identifier to match the Prisma enum by name. It does NOT verify that the runtime symbol is actually the Prisma enum (the user could `import { BookingStatus } from "./fake"` and we wouldn't notice). For the realistic case where Prisma is the only source, this is fine.

## See also

- R01 — Zod ↔ Prisma field drift (general type compatibility)
- R04 — Nullability mismatch (orthogonal — enum field can also have nullability drift)
