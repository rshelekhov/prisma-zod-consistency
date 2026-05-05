// Good fixture for R05 (Next.js App Router Route Handler).
//
// We DO call `request.json()` directly here, but immediately pipe through a
// Zod schema. R05 doesn't try to track the dataflow request → parse (that's
// fragile), so it would still flag the `.json()` call. The canonical way to
// silence the false positive is a `// pz-disable-next-line R05` comment that
// makes the intent explicit.

import { z } from "zod";

const createUserSchema = z.object({
  name: z.string().min(1).max(100),
  email: z.string().email(),
});

export async function POST(request: Request) {
  // pz-disable-next-line R05 -- parsed below
  const raw = await request.json();
  const body = createUserSchema.parse(raw);
  // pretend `prisma.user.create({ data: body })` is here
  return Response.json({ ok: true, body });
}
