import { z } from "zod";

// Field-level drift: booking.status is BookingStatus enum in Prisma
// but Zod typed as plain z.string(). Should be z.nativeEnum(BookingStatus).
export const bookingDtoSchema = z.object({
  id: z.string(),
  status: z.string(),
});
