// Good fixture for R05: route uses zValidator middleware and reads via c.req.valid().

import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";

const createUserSchema = z.object({
  name: z.string().min(1),
});

export const usersRoute = new Hono();

usersRoute.post("/", zValidator("json", createUserSchema), async (c) => {
  const body = c.req.valid("json"); // ← validated, typed, safe to pass to prisma.
  return c.json({ ok: true, body });
});
