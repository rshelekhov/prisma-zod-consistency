// Hand-rolled stand-in for `zod-prisma-types` output.
// Mirrors the convention `<Model>Schema = z.object({...})` that R01b reads.
// The shape matches the Prisma User model exactly — no findings expected.

import { z } from "zod";

export const UserSchema = z.object({
  id: z.string(),
  email: z.string().max(255),
  name: z.string().max(100),
  age: z.number().int(),
});
