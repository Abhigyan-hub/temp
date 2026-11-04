import jwt from "jsonwebtoken";
import { env } from "../config/env.js";

export const AUTH_COOKIE = "mf_token";

export function signToken(user) {
  return jwt.sign({ sub: String(user._id), tv: user.tokenVersion ?? 0 }, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN,
  });
}

export function cookieOptions() {
  return {
    httpOnly: true,
    secure: env.isProd || env.COOKIE_SAMESITE === "none",
    sameSite: env.COOKIE_SAMESITE,
    path: "/",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  };
}
