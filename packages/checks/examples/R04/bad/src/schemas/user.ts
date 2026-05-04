import { z } from "zod";

// Drifts:
//   1. `email` is required in Prisma but Zod is .nullable() — API accepts null,
//      DB will reject on insert/update.
//   2. `name` is optional in Prisma but Zod has neither .nullable() nor
//      .optional() — DB reads with NULL will fail to parse.
//   3. `bio` is optional in Prisma but Zod has only .min(1) (no nullability) —
//      same problem as `name`.
export const userSchema = z.object({
  id: z.string(),
  email: z.string().nullable(),
  name: z.string(),
  bio: z.string().min(1),
});
