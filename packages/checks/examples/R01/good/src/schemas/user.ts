import { z } from "zod";

export const userSchema = z.object({
  id: z.string(),
  email: z.string().email().max(255),
  name: z.string().max(100),
  age: z.number().int(),
  tags: z.array(z.string()),
});
