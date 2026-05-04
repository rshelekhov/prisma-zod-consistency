// Bad fixture for R05: route reads c.req.json() directly, no Zod boundary.

import { Hono } from "hono";

export const usersRoute = new Hono();

usersRoute.post("/", async (c) => {
  const body = await c.req.json(); // ← bypass: untyped, untrusted body straight into prisma.create.
  // (in a real bad case this body would flow into prisma.user.create({ data: body }))
  return c.json({ ok: true, body });
});

usersRoute.put("/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json(); // ← second bypass.
  return c.json({ ok: true, id, body });
});
