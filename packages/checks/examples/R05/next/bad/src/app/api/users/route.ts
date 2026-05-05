// Bad fixture for R05 (Next.js App Router Route Handler).
// `request.json()` is read directly without a Zod parse — untyped client
// data flows straight into the handler. Textbook bypass.

export async function POST(request: Request) {
  const body = await request.json();
  // pretend `prisma.user.create({ data: body })` is here
  return Response.json({ ok: true, body });
}
