import { Router } from "express";
import * as c from "../controllers/resumeController.js";
import { uploadLimiter } from "../middleware/security.js";
import { receiveResumeFiles } from "../middleware/upload.js";
import { validate } from "../middleware/validate.js";
import { idParams } from "../utils/validators.js";

export const resumeRoutes = Router();

resumeRoutes.get("/", validate({ query: c.schemas.list }), c.list);
resumeRoutes.get("/status", c.status);
resumeRoutes.post("/upload", uploadLimiter, receiveResumeFiles, c.upload);
resumeRoutes.get("/:id", validate({ params: idParams }), c.getOne);
resumeRoutes.get("/:id/download", validate({ params: idParams, query: c.schemas.download }), c.download);
resumeRoutes.put("/:id", validate({ params: idParams, body: c.schemas.update }), c.update);
resumeRoutes.delete("/:id", validate({ params: idParams }), c.remove);

export const resumeCategoryRoutes = Router();

resumeCategoryRoutes.get("/", c.listCategories);
resumeCategoryRoutes.post("/", validate({ body: c.schemas.category }), c.createCategory);
resumeCategoryRoutes.put("/:id", validate({ params: idParams, body: c.schemas.category }), c.renameCategory);
resumeCategoryRoutes.delete("/:id", validate({ params: idParams }), c.deleteCategory);
