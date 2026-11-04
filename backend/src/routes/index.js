import { Router } from "express";
import * as accounts from "../controllers/emailAccountController.js";
import * as campaigns from "../controllers/campaignController.js";
import * as emails from "../controllers/emailController.js";
import * as incoming from "../controllers/incomingController.js";
import * as schedules from "../controllers/scheduleController.js";
import * as settings from "../controllers/settingsController.js";
import { requireAuth } from "../middleware/auth.js";
import { sendLimiter } from "../middleware/security.js";
import { validate } from "../middleware/validate.js";
import { idParams } from "../utils/validators.js";
import authRoutes from "./authRoutes.js";
import contactRoutes from "./contactRoutes.js";
import { resumeCategoryRoutes, resumeRoutes } from "./resumeRoutes.js";
import templateRoutes from "./templateRoutes.js";

const api = Router();

api.use("/auth", authRoutes);

// Everything below requires a verified session.
api.use(requireAuth);

api.use("/contacts", contactRoutes);
api.use("/templates", templateRoutes);
api.use("/resumes", resumeRoutes);
api.use("/resume-categories", resumeCategoryRoutes);

const emailRoutes = Router();
emailRoutes.post("/send", sendLimiter, validate({ body: emails.schemas.send }), emails.send);
emailRoutes.post("/test", sendLimiter, emails.sendTest);
emailRoutes.get("/history", validate({ query: emails.schemas.history }), emails.history);
emailRoutes.get("/stats", emails.stats);
api.use("/emails", emailRoutes);

const scheduleRoutes = Router();
scheduleRoutes.get("/", validate({ query: schedules.schemas.list }), schedules.list);
scheduleRoutes.post("/", validate({ body: schedules.schemas.create }), schedules.create);
scheduleRoutes.patch("/:id", validate({ params: idParams, body: schedules.schemas.update }), schedules.update);
scheduleRoutes.patch("/:id/cancel", validate({ params: idParams }), schedules.cancel);
scheduleRoutes.post("/:id/send-now", sendLimiter, validate({ params: idParams }), schedules.sendNow);
scheduleRoutes.delete("/:id", validate({ params: idParams }), schedules.remove);
api.use("/schedules", scheduleRoutes);

const campaignRoutes = Router();
campaignRoutes.get("/", validate({ query: campaigns.schemas.list }), campaigns.list);
campaignRoutes.post("/", sendLimiter, validate({ body: campaigns.schemas.create }), campaigns.create);
campaignRoutes.get("/active", campaigns.active);
campaignRoutes.get("/:id", validate({ params: idParams }), campaigns.progress);
campaignRoutes.get("/:id/progress", validate({ params: idParams }), campaigns.progress);
campaignRoutes.get("/:id/events", validate({ params: idParams }), campaigns.events);
campaignRoutes.post("/:id/cancel", validate({ params: idParams }), campaigns.cancel);
campaignRoutes.post("/:id/retry", sendLimiter, validate({ params: idParams }), campaigns.retry);
api.use("/campaigns", campaignRoutes);

const accountRoutes = Router();
accountRoutes.get("/", accounts.list);
accountRoutes.post("/", validate({ body: accounts.schemas.create }), accounts.create);
accountRoutes.post("/system/test", sendLimiter, accounts.testSystem);
accountRoutes.put("/:id", validate({ params: idParams, body: accounts.schemas.update }), accounts.update);
accountRoutes.delete("/:id", validate({ params: idParams }), accounts.remove);
accountRoutes.post("/:id/default", validate({ params: idParams }), accounts.setDefault);
accountRoutes.post("/:id/test", sendLimiter, validate({ params: idParams }), accounts.test);
accountRoutes.post("/:id/test-send", sendLimiter, validate({ params: idParams }), accounts.testSend);
api.use("/email-accounts", accountRoutes);

const incomingRoutes = Router();
incomingRoutes.get("/", validate({ query: incoming.schemas.list }), incoming.list);
incomingRoutes.get("/status", incoming.status);
incomingRoutes.post("/sync", sendLimiter, incoming.sync);
api.use("/incoming", incomingRoutes);

api.get("/settings", settings.get);
api.put("/settings", validate({ body: settings.schemas.update }), settings.update);

export default api;
