import { Router } from "express";
import * as c from "../controllers/contactController.js";
import * as intel from "../controllers/contactIntelController.js";
import { validate } from "../middleware/validate.js";
import { idParams } from "../utils/validators.js";

const r = Router();

r.get("/", validate({ query: c.schemas.list }), c.list);
r.post("/", validate({ body: c.schemas.create }), c.create);
r.post("/import", validate({ body: c.schemas.import }), c.importContacts);

// Fixed paths before /:id.
r.get("/analytics", validate({ query: intel.schemas.analytics }), intel.analytics);
r.get("/check-email", validate({ query: intel.schemas.checkEmail }), intel.checkEmail);
r.get("/follow-ups/upcoming", intel.upcomingFollowUps);

r.get("/:id", validate({ params: idParams }), intel.getOne);
r.put("/:id", validate({ params: idParams, body: c.schemas.update }), c.update);
r.delete("/:id", validate({ params: idParams }), c.remove);
r.patch("/:id/block", validate({ params: idParams, body: c.schemas.block }), c.toggleBlock);

r.patch("/:id/email", validate({ params: idParams, body: intel.schemas.changeEmail }), intel.changeEmail);
r.patch("/:id/status", validate({ params: idParams, body: intel.schemas.changeStatus }), intel.changeStatus);

r.get("/:id/activity", validate({ params: idParams, query: intel.schemas.timeline }), intel.activity);
r.get("/:id/email-history", validate({ params: idParams }), intel.emailHistory);
r.get("/:id/incoming", validate({ params: idParams }), intel.incoming);

r.get("/:id/notes", validate({ params: idParams }), intel.listNotes);
r.post("/:id/notes", validate({ params: idParams, body: intel.schemas.note }), intel.createNote);
r.put("/:id/notes/:noteId", validate({ params: intel.schemas.noteParams, body: intel.schemas.note }), intel.updateNote);
r.delete("/:id/notes/:noteId", validate({ params: intel.schemas.noteParams }), intel.removeNote);

r.get("/:id/follow-ups", validate({ params: idParams }), intel.listFollowUps);
r.post("/:id/follow-ups", validate({ params: idParams, body: intel.schemas.followUpCreate }), intel.createFollowUp);
r.patch("/:id/follow-ups/:followUpId", validate({ params: intel.schemas.followUpParams, body: intel.schemas.followUpUpdate }), intel.updateFollowUp);

export default r;
