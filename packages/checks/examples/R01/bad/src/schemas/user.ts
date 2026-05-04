import { z } from "zod";

// Four drifts from the Prisma User model:
//   1. `email` has no .max(255) — Postgres will reject strings >255.
//   2. `name` has .max(500) but Prisma is @db.VarChar(100) — Zod is looser.
//   3. `age` is z.number() but Prisma is Int — non-integers slip through.
//   4. `tags` is z.string() but Prisma is `String[]` — should be z.array(z.string()).
export const userSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string().max(500),
  age: z.number(),
  tags: z.string(),
});
