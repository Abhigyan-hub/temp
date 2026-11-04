import { z } from "zod";
import { User } from "../models/User.js";
import { AppError } from "../utils/AppError.js";
import { emailField } from "../utils/validators.js";

const isTimezone = (tz) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

export const schemas = {
  update: z.object({
    name: z.string().trim().min(1, "Name is required").max(100).optional(),
    email: emailField.optional(),
    profile: z
      .object({
        senderName: z.string().trim().max(100).optional(),
        signature: z.string().max(2000).optional(),
      })
      .optional(),
    settings: z
      .object({
        timezone: z.string().trim().max(64).refine(isTimezone, "Unknown timezone").optional(),
        defaultSendTime: z
          .string()
          .regex(/^\d{2}:\d{2}$/, "Use HH:mm")
          .optional(),
        sendingMode: z.enum(["system", "custom"]).optional(),
      })
      .optional(),
  }),
};

export function get(req, res) {
  res.json({ success: true, user: req.user });
}

export async function update(req, res) {
  const { name, email, profile, settings } = req.body;
  const user = req.user;

  if (email && email !== user.email) {
    if (await User.exists({ email, _id: { $ne: user._id } })) {
      throw new AppError(409, "Another account already uses this email");
    }
    user.email = email;
  }
  if (name) user.name = name;
  for (const [k, v] of Object.entries(profile ?? {})) if (v !== undefined) user.profile[k] = v;
  for (const [k, v] of Object.entries(settings ?? {})) if (v !== undefined) user.settings[k] = v;

  await user.save();
  res.json({ success: true, user });
}
