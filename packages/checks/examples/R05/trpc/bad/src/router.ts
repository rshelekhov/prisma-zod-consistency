// Bad fixture for R05 (tRPC): three procedures that accept `input` but never
// declare `.input(zodSchema)`. Each is a textbook bypass — untyped client
// data flows straight into the handler.

import { initTRPC } from "@trpc/server";

const t = initTRPC.create();

export const publicProcedure = t.procedure;
export const protectedProcedure = t.procedure;

export const router = t.router({
  // Bare `procedure` reference, no `.input(...)`, handler reads `input`.
  getUser: t.procedure.query(({ input }) => {
    return { id: input };
  }),

  // `publicProcedure` (typed via middleware), `.mutation(...)` with raw input
  // streamed into prisma.create — the most dangerous variant.
  createUser: publicProcedure.mutation(({ input }) => {
    // pretend `prisma.user.create({ data: input })` is here
    return { ok: true, body: input };
  }),

  // `protectedProcedure` (auth-gated), still no `.input(...)`. Handler uses
  // a single `input` parameter (not destructured).
  updateUser: protectedProcedure.mutation((input) => {
    return { updated: input };
  }),
});
