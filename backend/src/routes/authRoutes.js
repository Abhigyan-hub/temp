import { Router } from "express";
import * as c from "../controllers/authController.js";
import { requireAuth } from "../middleware/auth.js";
import { authLimiter } from "../middleware/security.js";
import { validate } from "../middleware/validate.js";

const r = Router();

r.post("/register", authLimiter, validate({ body: c.schemas.register }), c.register);
r.post("/login", authLimiter, validate({ body: c.schemas.login }), c.login);
r.post("/logout", c.logout);
r.post("/forgot-password", authLimiter, validate({ body: c.schemas.forgot }), c.forgotPassword);
r.post("/reset-password", authLimiter, validate({ body: c.schemas.reset }), c.resetPassword);
r.get("/me", requireAuth, c.me);
r.put("/password", requireAuth, authLimiter, validate({ body: c.schemas.changePassword }), c.changePassword);

export default r;
