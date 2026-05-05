// Bad fixture for R05 (Next.js Pages Router API).
// `req.body` is accessed directly off the handler's first parameter without
// a Zod parse — the legacy bypass shape.

import type { NextApiRequest, NextApiResponse } from "next";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const body = req.body;
  // pretend `prisma.session.create({ data: body })` is here
  res.status(200).json({ ok: true, body });
}
