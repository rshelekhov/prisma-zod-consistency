// Good fixture for R05 (Next.js Pages Router API).
// `req.body` is parsed through a Zod schema in the same function — this
// shape is auto-skipped by the detector.

import type { NextApiRequest, NextApiResponse } from "next";
import { z } from "zod";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const body = loginSchema.parse(req.body);
  // pretend `verifyCredentials(body)` is here
  res.status(200).json({ ok: true, email: body.email });
}
