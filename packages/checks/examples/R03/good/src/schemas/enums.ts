import { BookingStatus, UserRole } from "@prisma/client";
import { z } from "zod";

export const bookingStatusSchema = z.nativeEnum(BookingStatus);
export const userRoleSchema = z.nativeEnum(UserRole);
