// Local barrel that re-exports from the generated dir. Used to test that
// transitive symbol resolution traces UserSchema back into outputDir.

export { UserSchema } from "../../generated/zod/index.js";
