// Bad R01c usage. Two distinct weakening patterns:
//   1. `.passthrough()` — defeats the validator entirely; unknown keys flow
//      into prisma.create(). Most dangerous, always error.
//   2. Re-export through a barrel and then `.passthrough()` — same defect,
//      delivered through indirection that pure path-based AND would miss.

import { z } from "zod";
// Direct import from generated:
import { UserSchema } from "../../generated/zod/index.js";
// Re-imported through the local barrel (see ./index.ts) — must still be flagged.
import { UserSchema as RexportedUserSchema } from "./index.js";

// 1. Direct passthrough on generated schema.
export const createUserInputSchema = UserSchema.passthrough();

// 2. Passthrough on a barrel re-export. Path-based-with-AND would miss this;
//    the transitive resolution we implement catches it.
export const updateUserInputSchema = RexportedUserSchema.passthrough();

// (z import retained so file passes the zod-import quick-reject in discovery.)
void z;
