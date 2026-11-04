import { Router } from "express";
import * as c from "../controllers/templateController.js";
import { validate } from "../middleware/validate.js";
import { idParams } from "../utils/validators.js";

const r = Router();

r.get("/", validate({ query: c.schemas.list }), c.list);
r.post("/", validate({ body: c.schemas.create }), c.create);
r.put("/:id", validate({ params: idParams, body: c.schemas.update }), c.update);
r.delete("/:id", validate({ params: idParams }), c.remove);
r.post("/:id/duplicate", validate({ params: idParams }), c.duplicate);
r.patch("/:id/favorite", validate({ params: idParams }), c.toggleFavorite);

export default r;
