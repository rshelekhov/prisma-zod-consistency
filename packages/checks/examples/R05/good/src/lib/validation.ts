// The validator wrapper itself imports @hono/zod-validator. R05 must NOT
// flag the c.req.json() call inside the wrapper, because it IS the validator.

import { zValidator } from "@hono/zod-validator";
import type { ZodSchema } from "zod";

export function validated<S extends ZodSchema>(
  target: "json" | "form" | "query" | "param",
  schema: S,
) {
  return zValidator(target, schema);
}

// Hypothetical helper that internally reads the body — should be ignored
// because this file imports @hono/zod-validator.
export async function readJsonOnce<T>(c: { req: { json: () => Promise<T> } }) {
  return await c.req.json();
}
