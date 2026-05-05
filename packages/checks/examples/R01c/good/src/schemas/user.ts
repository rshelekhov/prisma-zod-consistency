// Good R01c usage: schemas legitimately narrow the generated UserSchema.
// `.pick({...}).extend({...})` with stricter rules is the canonical way
// to derive a public/input schema from generated.

import { z } from "zod";
import { UserSchema } from "../../generated/zod/index.js";

// Public profile — drops sensitive fields. Allowed: pick is intentional narrowing.
export const userPublicSchema = UserSchema.pick({
  id: true,
  name: true,
});

// Account creation input — narrows to a subset and tightens email format.
export const createUserInputSchema = UserSchema.pick({
  email: true,
  name: true,
  passwordHash: true,
}).extend({
  acceptedTos: z.literal(true),
});
