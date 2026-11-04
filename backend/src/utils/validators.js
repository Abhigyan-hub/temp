import mongoose from "mongoose";
import { z } from "zod";
import { isValidEmail, normalizeEmail } from "../shared/contactData.js";

export { EMAIL_RE, isValidEmail } from "../shared/contactData.js";

export const objectId = z.string().refine((v) => mongoose.isValidObjectId(v), "Invalid id");
export const idParams = z.object({ id: objectId });

export const emailField = z
  .string({ error: "Email is required" })
  .transform(normalizeEmail)
  .refine((v) => v.length > 0, "Email is required")
  .refine(isValidEmail, "Enter a valid email address");

export const optionalText = (max) => z.string().trim().max(max).optional().default("");

export const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
