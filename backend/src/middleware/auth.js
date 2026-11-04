import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { User } from "../models/User.js";
import { AppError } from "../utils/AppError.js";
import { AUTH_COOKIE } from "../utils/auth.js";

/** Verifies the JWT and loads the user. The user id comes only from the verified token. */
export async function requireAuth(req, _res, next) {
  const header = req.get("authorization");
  const token = req.cookies?.[AUTH_COOKIE] || (header?.startsWith("Bearer ") ? header.slice(7) : null);
  if (!token) return next(new AppError(401, "Authentication required"));

  let payload;
  try {
    payload = jwt.verify(token, env.JWT_SECRET);
  } catch {
    return next(new AppError(401, "Session expired, please sign in again"));
  }

  const user = await User.findById(payload.sub).select("+tokenVersion");
  if (!user || (user.tokenVersion ?? 0) !== (payload.tv ?? 0)) {
    return next(new AppError(401, "Session expired, please sign in again"));
  }
  req.user = user;
  next();
}
