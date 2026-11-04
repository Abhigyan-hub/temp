import { rateLimit } from "express-rate-limit";
import { env } from "../config/env.js";
import { AppError } from "../utils/AppError.js";

/** Remove keys that could be interpreted as Mongo operators or paths ($where, a.b). */
function strip(value) {
  if (Array.isArray(value)) return value.map(strip);
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) {
      if (key.startsWith("$") || key.includes(".")) delete value[key];
      else value[key] = strip(value[key]);
    }
  }
  return value;
}

export function sanitizeInput(req, _res, next) {
  if (req.body) strip(req.body);
  if (req.params) strip(req.params);
  next();
}

/**
 * State-changing requests must carry a custom header. Browsers cannot add it cross-origin
 * without a CORS preflight, which our CORS policy only allows for the frontend's origin.
 */
export function requireCsrfHeader(req, _res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  if (req.get("x-requested-with") !== "mailflow") {
    return next(new AppError(403, "Missing request header"));
  }
  next();
}

const limiter = (windowMs, limit, message) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    skip: () => env.NODE_ENV === "test",
    handler: (_req, _res, next) => next(new AppError(429, message)),
  });

export const apiLimiter = limiter(15 * 60 * 1000, 600, "Too many requests, please slow down");
export const authLimiter = limiter(15 * 60 * 1000, 20, "Too many attempts, try again in a few minutes");
export const uploadLimiter = limiter(15 * 60 * 1000, 30, "Too many uploads, try again in a few minutes");
export const sendLimiter =limiter(60 * 1000, 10, "Too many send requests, wait a minute");
