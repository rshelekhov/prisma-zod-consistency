// Hand-rolled stand-in for `zod-prisma-types` output. The user's hand-written
// schemas in src/schemas/ derive from this UserSchema.

import { z } from "zod";

export const UserSchema = z.object({
  id: z.string(),
  email: z.string().max(255),
  name: z.string().max(100),
  passwordHash: z.string(),
});
