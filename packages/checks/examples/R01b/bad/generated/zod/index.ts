// Hand-rolled stand-in for misconfigured `zod-prisma-types` output.
// Three drifts vs schema.prisma's User model:
//   1. `email`: `.max(500)` exceeds `@db.VarChar(255)` (loose-max).
//   2. `name`:  no `.max()` despite `@db.VarChar(100)` (missing-max).
//   3. `age`:   missing `.int()` on an Int column (missing-int).
//
// All three are realistic outcomes of stale generator output or a
// misconfigured `@zod.string.max(N)` annotation in schema.prisma.

import { z } from "zod";

export const UserSchema = z.object({
  id: z.string(),
  email: z.string().max(500),
  name: z.string(),
  age: z.number(),
});
