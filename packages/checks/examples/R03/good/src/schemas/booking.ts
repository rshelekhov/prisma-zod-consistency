import { BookingStatus } from "@prisma/client";
import { z } from "zod";

export const bookingDtoSchema = z.object({
  id: z.string(),
  status: z.nativeEnum(BookingStatus),
});
