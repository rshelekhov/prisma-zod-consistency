import { z } from "zod";

// Three drifts:
//   1. bookingStatusSchema is missing COMPLETED.
//   2. bookingStatusSchema has REFUNDED that doesn't exist in Prisma.
//   3. userRoleSchema uses z.enum(["admin","manager","client"]) — wrong case.
export const bookingStatusSchema = z.enum([
  "DRAFT",
  "CONFIRMED",
  "CANCELLED",
  "REFUNDED",
]);

export const userRoleSchema = z.enum(["admin", "manager", "client"]);
