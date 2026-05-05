// Good fixture for R05 (Next.js Server Action — file-level `'use server'`).
// FormData is parsed through Zod via `Object.fromEntries(...)` before any
// fields are read. This shape is auto-skipped by the detector — no
// suppression comment needed.

"use server";

import { z } from "zod";

const createUserSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
});

export async function createUser(formData: FormData) {
  const data = createUserSchema.parse(Object.fromEntries(formData));
  // pretend `prisma.user.create({ data })` is here
  return { ok: true, data };
}
