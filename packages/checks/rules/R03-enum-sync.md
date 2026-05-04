# R03 — Enum sync between Prisma and Zod

**Severity (default):** error
**Phase:** 1 (skill), 2 (CLI)
**Surface:** both
**Group:** A (static)

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

## See also

- R01 — Zod ↔ Prisma field drift (general type compatibility)
