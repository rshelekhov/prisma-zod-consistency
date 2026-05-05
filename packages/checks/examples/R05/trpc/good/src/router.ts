// Good fixture for R05 (tRPC): every procedure either declares an explicit
// `.input(...)` Zod schema, declares `.input(z.void())` to opt out, or has
// no `input` parameter at all.

import { initTRPC } from "@trpc/server";
import { z } from "zod";

const t = initTRPC.create();

export const router = t.router({
  // Canonical: `.input(z.object(...))` before `.query(...)`.
  getUser: t.procedure
    .input(z.object({ id: z.string() }))
    .query(({ input }) => {
      return { id: input.id };
    }),

  // Mutation with explicit Zod input.
  createUser: t.procedure
    .input(z.object({ name: z.string().min(1) }))
    .mutation(({ input }) => {
      return { ok: true, body: input };
    }),

  // Explicit no-input declaration via `z.void()` — intentional, not a bypass.
  ping: t.procedure.input(z.void()).query(({ input }) => {
    void input;
    return "pong";
  }),

  // Procedure without an `input` parameter — pure GET, validation not applicable.
  listUsers: t.procedure.query(() => {
    return [{ id: "1" }, { id: "2" }];
  }),
});
