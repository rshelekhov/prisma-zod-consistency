// Bad fixture for R05 (Next.js Server Action — file-level `'use server'`).
// FormData is read via `.get(...)` without a Zod parse. Mass-assignment risk:
// untyped client values flow straight into prisma.create.

"use server";

export async function createUser(formData: FormData) {
  const name = formData.get("name");
  const email = formData.get("email");
  // pretend `prisma.user.create({ data: { name, email } })` is here
  return { ok: true, name, email };
}
