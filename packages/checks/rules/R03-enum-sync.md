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

For every enum declared in `schema.prisma`, every Zod schema referencing it must include exactly the same set of values. The rule covers two patterns:

- **`z.nativeEnum(PrismaEnum)`** — type-safe by construction; the rule still verifies that the imported symbol matches the expected Prisma enum and is not aliased to something else.
- **`z.enum(['VALUE_1', 'VALUE_2'])`** — value literals; the rule does a set comparison against the Prisma enum and flags any missing or extra values.

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

## Common false positives

- **`z.string()` instead of enum is *sometimes* intentional.** If a DTO is meant to be public-API-consumable and the team prefers permissive typing on the wire (because enum values may evolve and they don't want every consumer to break on a new value), they may type the field as `z.string()` deliberately. This is unusual but happens. Acceptable but should be documented; flagging it as `info` rather than `error` is a config option.
- **Top-level `userRoleSchema = z.enum(["admin", "manager"])`** when Prisma has `enum UserRole { ADMIN MANAGER }` — case mismatch is almost always a real bug (Prisma is case-sensitive), not a stylistic choice. Worth flagging hard.
- **Subset enum schemas** (intentionally narrower than Prisma's). E.g. a `managerSettableStatusSchema = z.enum([BookingStatus.CONFIRMED, BookingStatus.CANCELLED])` for a UI control that only allows two of the four states. These DO get flagged as "missing values". Add their schema names to `ignoreEnums` (or reference the Prisma enum members like in the example, which uses the imported symbols and avoids the literal-string drift entirely).

## Implementation notes

- **Field-level matching.** The rule walks Zod object schemas matched to Prisma models (via the same `matchSchemasToModels` heuristic R01/R04 use). For each Prisma field whose type is an enum, it looks for the same-named Zod field and checks that the Zod side is `z.enum`/`z.nativeEnum` with matching values.
- **Auto-fix scope.** Only the base call (`z.string()` → `z.nativeEnum(EnumName)`) is auto-fixed. Trailing modifiers like `.nullable()`, `.optional()`, `.default(...)` are preserved. Import management uses a heuristic scan of the first ~80 lines for an existing import naming the symbol; if absent, prepends `import { X } from "@prisma/client";`. Adding to an existing `@prisma/client` import (instead of a separate line) is a polish task.
- **`z.nativeEnum` identifier check.** The rule trusts the imported identifier to match the Prisma enum by name. It does NOT verify that the runtime symbol is actually the Prisma enum (the user could `import { BookingStatus } from "./fake"` and we wouldn't notice). For the realistic case where Prisma is the only source, this is fine.

## See also

- R01 — Zod ↔ Prisma field drift (general type compatibility)
- R04 — Nullability mismatch (orthogonal — enum field can also have nullability drift)
