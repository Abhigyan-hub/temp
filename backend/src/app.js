import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import mongoose from "mongoose";
import { API_PREFIX } from "./config/apiPath.js";
import { env } from "./config/env.js";
import { errorHandler, notFoundHandler } from "./middleware/error.js";
import { apiLimiter, requireCsrfHeader, sanitizeInput } from "./middleware/security.js";
import api from "./routes/index.js";
import { INSTANCE_ID } from "./utils/instance.js";

export function createApp() {
  const app = express();

  // Render / Vercel sit behind one proxy hop; needed for correct client IPs in rate limiting.
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  app.use(helmet());
  app.use(
    cors({
      origin: (origin, cb) => cb(null, !origin || env.corsOrigins.includes(origin)),
      credentials: true,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
      allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
    }),
  );
  app.use(express.json({ limit: "5mb" }));
  app.use(cookieParser());
  app.use(sanitizeInput);

  app.get(`${API_PREFIX}/health`, (_req, res) => {
    res.json({
      success: true,
      status: "ok",
      db: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
      email: env.EMAIL_TRANSPORT === "json" ? "dry-run" : "live",
      // Lets a starting server detect that a *different* process is answering on its port.
      instance: INSTANCE_ID,
    });
  });

  app.use(API_PREFIX, apiLimiter, requireCsrfHeader, api);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
