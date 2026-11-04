import { z } from "zod";
import { Resume } from "../models/Resume.js";
import { ScheduledEmail } from "../models/ScheduledEmail.js";
import { Template } from "../models/Template.js";
import { notFound } from "../utils/AppError.js";
import { escapeRegex, objectId } from "../utils/validators.js";

const fields = {
  name: z.string({ error: "Template name is required" }).trim().min(1, "Template name is required").max(150),
  subject: z.string({ error: "Subject is required" }).trim().min(1, "Subject is required").max(300),
  body: z.string({ error: "Body is required" }).min(1, "Body is required").max(20000),
  category: z.string().trim().max(80).transform((v) => v || "General"),
  isFavorite: z.boolean(),
  // Optional resume preselected in Compose; null removes it.
  defaultResumeId: objectId.nullable(),
};

export const schemas = {
  list: z.object({
    search: z.string().trim().max(100).optional(),
    category: z.string().trim().max(80).optional(),
    favorite: z.enum(["true", "false"]).optional(),
  }),
  create: z.object({
    ...fields,
    category: fields.category.optional().default("General"),
    isFavorite: fields.isFavorite.optional(),
    defaultResumeId: fields.defaultResumeId.optional().default(null),
  }),
  update: z.object(fields).partial(),
};

const own = (req) => ({ _id: req.params.id, userId: req.user._id });

export async function list(req, res) {
  const { search, category, favorite } = req.validatedQuery;
  const filter = { userId: req.user._id };
  if (category) filter.category = category;
  if (favorite) filter.isFavorite = favorite === "true";
  if (search) {
    const re = new RegExp(escapeRegex(search), "i");
    filter.$or = [{ name: re }, { subject: re }, { body: re }];
  }
  const templates = await Template.find(filter).sort({ createdAt: 1 });
  res.json({ success: true, templates });
}

/** A default resume must be one of the user's own. */
async function assertOwnResume(req) {
  const id = req.body.defaultResumeId;
  if (id && !(await Resume.exists({ _id: id, userId: req.user._id, deletingAt: null }))) throw notFound("Resume");
}

export async function create(req, res) {
  await assertOwnResume(req);
  const template = await Template.create({ ...req.body, userId: req.user._id });
  res.status(201).json({ success: true, template });
}

export async function update(req, res) {
  await assertOwnResume(req);
  const template = await Template.findOneAndUpdate(own(req), req.body, { returnDocument: "after", runValidators: true });
  if (!template) throw notFound("Template");
  res.json({ success: true, template });
}

export async function remove(req, res) {
  const template = await Template.findOneAndDelete(own(req));
  if (!template) throw notFound("Template");
  await ScheduledEmail.updateMany(
    { userId: req.user._id, templateId: template._id, status: "Pending" },
    { status: "Cancelled", errorMessage: "Template deleted", processedAt: new Date() },
  );
  res.json({ success: true });
}

export async function duplicate(req, res) {
  const t = await Template.findOne(own(req));
  if (!t) throw notFound("Template");
  const copy = await Template.create({
    userId: req.user._id,
    name: `${t.name} (Copy)`.slice(0, 150),
    subject: t.subject,
    body: t.body,
    category: t.category,
    defaultResumeId: t.defaultResumeId,
  });
  res.status(201).json({ success: true, template: copy });
}

export async function toggleFavorite(req, res) {
  const t = await Template.findOne(own(req));
  if (!t) throw notFound("Template");
  t.isFavorite = !t.isFavorite;
  await t.save();
  res.json({ success: true, template: t });
}
