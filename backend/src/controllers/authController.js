import crypto from "node:crypto";
import { z } from "zod";
import { env } from "../config/env.js";
import { User } from "../models/User.js";
import { sendMail } from "../services/emailService.js";
import { seedTemplatesFor } from "../services/seed.js";
import { AppError } from "../utils/AppError.js";
import { AUTH_COOKIE, cookieOptions, signToken } from "../utils/auth.js";
import { emailField } from "../utils/validators.js";

const password = z
  .string({ error: "Password is required" })
  .min(8, "Password must be at least 8 characters")
  .max(128, "Password is too long");

export const schemas = {
  register: z.object({
    name: z.string({ error: "Name is required" }).trim().min(1, "Name is required").max(100),
    email: emailField,
    password,
  }),
  login: z.object({
    email: emailField,
    password: z.string({ error: "Password is required" }).min(1, "Password is required").max(128),
  }),
  forgot: z.object({ email: emailField }),
  reset: z.object({ token: z.string().regex(/^[a-f0-9]{64}$/, "Invalid or expired reset link"), password }),
  changePassword: z.object({ currentPassword: z.string().min(1, "Current password is required"), newPassword: password }),
};

const hashToken = (t) => crypto.createHash("sha256").update(t).digest("hex");

function issueSession(res, user) {
  res.cookie(AUTH_COOKIE, signToken(user), cookieOptions());
}

export async function register(req, res) {
  const { name, email, password } = req.body;
  if (env.allowedSignupEmails.length && !env.allowedSignupEmails.includes(email)) {
    throw new AppError(403, "Registration is restricted for this MailFlow instance");
  }
  if (await User.exists({ email })) throw new AppError(409, "An account with this email already exists");

  const user = await User.create({ name, email, password, profile: { senderName: name } });
  await seedTemplatesFor(user);
  issueSession(res, user);
  res.status(201).json({ success: true, user });
}

export async function login(req, res) {
  const { email, password } = req.body;
  const user = await User.findOne({ email }).select("+password +tokenVersion");
  if (!user || !(await user.comparePassword(password))) {
    throw new AppError(401, "Invalid email or password");
  }
  issueSession(res, user);
  res.json({ success: true, user });
}

export function logout(_req, res) {
  const { maxAge: _maxAge, ...opts } = cookieOptions();
  res.clearCookie(AUTH_COOKIE, opts);
  res.json({ success: true });
}

export function me(req, res) {
  res.json({ success: true, user: req.user });
}

export async function forgotPassword(req, res) {
  const generic = { success: true, message: "If that email is registered, a reset link has been sent." };
  const user = await User.findOne({ email: req.body.email });
  if (!user) return res.json(generic);

  const token = crypto.randomBytes(32).toString("hex");
  user.resetPasswordTokenHash = hashToken(token);
  user.resetPasswordExpires = new Date(Date.now() + 30 * 60 * 1000);
  await user.save();

  const link = `${env.FRONTEND_URL.replace(/\/$/, "")}/reset-password?token=${token}`;
  const result = await sendMail({
    to: user.email,
    subject: "Reset your MailFlow password",
    text: `Hi ${user.name},\n\nUse the link below to reset your MailFlow password. It expires in 30 minutes.\n\n${link}\n\nIf you didn't request this, you can ignore this email.`,
    fromName: "MailFlow",
  });
  if (!result.success) {
    console.error("Password reset email failed:", result.error);
    throw new AppError(502, "Could not send the reset email. Try again later.");
  }
  res.json(generic);
}

export async function resetPassword(req, res) {
  const user = await User.findOne({
    resetPasswordTokenHash: hashToken(req.body.token),
    resetPasswordExpires: { $gt: new Date() },
  }).select("+tokenVersion");
  if (!user) throw new AppError(400, "Invalid or expired reset link");

  user.password = req.body.password;
  user.resetPasswordTokenHash = undefined;
  user.resetPasswordExpires = undefined;
  user.tokenVersion = (user.tokenVersion ?? 0) + 1; // sign out other sessions
  await user.save();
  res.json({ success: true, message: "Password updated. You can sign in now." });
}

export async function changePassword(req, res) {
  const user = await User.findById(req.user._id).select("+password +tokenVersion");
  if (!(await user.comparePassword(req.body.currentPassword))) {
    throw new AppError(400, "Current password is incorrect");
  }
  user.password = req.body.newPassword;
  user.tokenVersion = (user.tokenVersion ?? 0) + 1;
  await user.save();
  issueSession(res, user);
  res.json({ success: true, message: "Password changed" });
}
