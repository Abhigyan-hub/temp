import { randomUUID } from "node:crypto";
import { z } from "zod";
import { env } from "../config/env.js";
import { Resume } from "../models/Resume.js";
import { DEFAULT_RESUME_CATEGORIES, ResumeCategory } from "../models/ResumeCategory.js";
import { ScheduledEmail } from "../models/ScheduledEmail.js";
import { Template } from "../models/Template.js";
import { User } from "../models/User.js";
import {
  cleanName,
  contentDisposition,
  detectResumeType,
  displayNameFrom,
  fileNameFor,
  InvalidResumeError,
} from "../services/resumeFiles.js";
import { getStorage, StorageNotFoundError, StorageUnavailableError, storageStatus } from "../services/storage/index.js";
import { AppError, notFound } from "../utils/AppError.js";
import { escapeRegex } from "../utils/validators.js";

const categoryName = z
  .string()
  .transform(cleanName)
  .pipe(z.string().max(80));

const labels = z
  .array(z.string().transform(cleanName).pipe(z.string().min(1).max(40)))
  .max(10, "At most 10 labels")
  .transform((l) => [...new Set(l)]);

export const schemas = {
  list: z.object({
    search: z.string().trim().max(100).optional(),
    category: z.string().trim().max(80).optional(),
    fileType: z.enum(["pdf", "docx", "doc"]).optional(),
  }),
  update: z
    .object({
      name: z.string().transform(cleanName).pipe(z.string().min(1, "Name is required")),
      description: z.string().trim().max(1000),
      category: categoryName,
      labels,
    })
    .partial(),
  download: z.object({ inline: z.enum(["0", "1"]).optional() }),
  category: z.object({ name: categoryName.pipe(z.string().min(1, "Category name is required")) }),
};

function storageOr503() {
  try {
    return getStorage();
  } catch (err) {
    if (err instanceof StorageUnavailableError) throw new AppError(503, err.message);
    throw err;
  }
}

/** Make sure a category exists in the user's list (uploads and edits may introduce new ones). */
async function ensureCategory(userId, name) {
  if (!name) return;
  await ResumeCategory.updateOne(
    { userId, nameKey: name.toLowerCase() },
    { $setOnInsert: { userId, name, nameKey: name.toLowerCase() } },
    { upsert: true },
  );
}

const pendingUses = (userId, resumeId) =>
  ScheduledEmail.countDocuments({ userId, resumeIds: resumeId, status: { $in: ["Pending", "Processing"] } });

export function status(_req, res) {
  res.json({
    success: true,
    storage: storageStatus(),
    limits: {
      maxFileBytes: env.resumeMaxBytes,
      maxFilesPerUpload: env.RESUME_MAX_FILES_PER_UPLOAD,
      maxResumes: env.RESUME_MAX_PER_USER,
      maxAttachments: env.ATTACHMENT_MAX_COUNT,
      maxAttachmentBytes: env.attachmentMaxTotalBytes,
    },
  });
}

export async function list(req, res) {
  const { search, category, fileType } = req.validatedQuery;
  const filter = { userId: req.user._id, deletingAt: null };
  if (category) filter.category = category;
  if (fileType) filter.fileType = fileType;
  if (search) {
    const re = new RegExp(escapeRegex(search), "i");
    filter.$or = [{ name: re }, { originalFileName: re }, { description: re }, { labels: re }, { category: re }];
  }
  const resumes = await Resume.find(filter).sort({ uploadedAt: -1 }).limit(1000);
  res.json({ success: true, resumes });
}

export async function getOne(req, res) {
  const resume = await Resume.findOne({ _id: req.params.id, userId: req.user._id, deletingAt: null });
  if (!resume) throw notFound("Resume");
  res.json({ success: true, resume, pendingSchedules: await pendingUses(req.user._id, resume._id) });
}

export async function upload(req, res) {
  const userId = req.user._id;
  const files = req.uploadFiles ?? [];
  if (files.length === 0) throw new AppError(400, "Choose at least one PDF or Word file");
  const storage = storageOr503();

  const category = categoryName.safeParse(req.body.category ?? "").data ?? "";
  const description = String(req.body.description ?? "").trim().slice(0, 1000);
  let slots = env.RESUME_MAX_PER_USER - (await Resume.countDocuments({ userId }));

  const uploaded = [];
  const duplicates = [];
  const rejected = [];
  const seenHashes = new Map();

  for (const file of files) {
    const fileName = file.originalName || "file";
    if (file.truncated) {
      rejected.push({ fileName, reason: `Larger than the ${env.RESUME_MAX_MB} MB limit` });
      continue;
    }
    let type;
    try {
      type = await detectResumeType(file.tmpPath, fileName);
    } catch (err) {
      if (err instanceof InvalidResumeError) {
        rejected.push({ fileName, reason: err.message });
        continue;
      }
      throw err;
    }

    const existing = seenHashes.get(file.sha256) ?? (await Resume.findOne({ userId, sha256: file.sha256 }));
    if (existing) {
      duplicates.push({ fileName, existing: { id: String(existing._id), name: existing.name } });
      continue;
    }
    if (slots <= 0) {
      rejected.push({ fileName, reason: `Your library is full (${env.RESUME_MAX_PER_USER} resumes). Delete some first.` });
      continue;
    }

    // The key is generated here; nothing from the filename reaches the storage path.
    const storageKey = `resumes/${userId}/${randomUUID()}.${type.ext}`;
    await storage.put(storageKey, file.tmpPath, { contentType: type.mime, size: file.size });
    try {
      const resume = await Resume.create({
        userId,
        name: displayNameFrom(fileName),
        originalFileName: cleanName(fileName.split(/[\\/]/).pop()) || `resume.${type.ext}`,
        storageKey,
        fileType: type.ext,
        mimeType: type.mime,
        fileSize: file.size,
        sha256: file.sha256,
        category,
        description,
      });
      uploaded.push(resume);
      seenHashes.set(file.sha256, resume);
      slots--;
    } catch (err) {
      await storage.delete(storageKey).catch(() => {});
      if (err?.code === 11000) {
        duplicates.push({ fileName, existing: null });
        continue;
      }
      throw err;
    }
  }

  await ensureCategory(userId, category);
  res.status(uploaded.length ? 201 : 200).json({ success: true, uploaded, duplicates, rejected });
}

export async function download(req, res) {
  const resume = await Resume.findOne({ _id: req.params.id, userId: req.user._id, deletingAt: null });
  if (!resume) throw notFound("Resume");
  const storage = storageOr503();

  let stream;
  try {
    stream = await storage.getStream(resume.storageKey);
  } catch (err) {
    if (err instanceof StorageNotFoundError) throw new AppError(410, "This file is missing from storage. Please re-upload it.");
    throw err;
  }

  const inline = req.validatedQuery.inline === "1";
  res.set({
    "Content-Type": resume.mimeType,
    "Content-Length": String(resume.fileSize),
    "Content-Disposition": contentDisposition(inline ? "inline" : "attachment", fileNameFor(resume)),
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  });
  stream.on("error", (err) => {
    console.error(`Resume stream failed for ${resume._id}:`, err?.name ?? err);
    res.destroy(err);
  });
  stream.pipe(res);
}

export async function update(req, res) {
  const resume = await Resume.findOne({ _id: req.params.id, userId: req.user._id, deletingAt: null });
  if (!resume) throw notFound("Resume");
  for (const field of ["name", "description", "category", "labels"]) {
    if (req.body[field] !== undefined) resume[field] = req.body[field];
  }
  await resume.save();
  await ensureCategory(req.user._id, resume.category);
  res.json({ success: true, resume });
}

export async function remove(req, res) {
  const userId = req.user._id;
  // Lock first so no new schedule can reference the file, then check existing ones.
  const resume = await Resume.findOneAndUpdate(
    { _id: req.params.id, userId, deletingAt: null },
    { $set: { deletingAt: new Date() } },
    { returnDocument: "after" },
  );
  if (!resume) throw notFound("Resume");

  const uses = await pendingUses(userId, resume._id);
  if (uses > 0) {
    await Resume.updateOne({ _id: resume._id }, { $set: { deletingAt: null } });
    throw new AppError(
      409,
      `This resume is attached to ${uses} scheduled email${uses === 1 ? "" : "s"}. Cancel or send ${uses === 1 ? "it" : "them"} before deleting.`,
    );
  }

  try {
    await storageOr503().delete(resume.storageKey);
  } catch (err) {
    await Resume.updateOne({ _id: resume._id }, { $set: { deletingAt: null } });
    if (err instanceof AppError) throw err;
    console.error(`Storage delete failed for resume ${resume._id}:`, err?.name ?? err);
    throw new AppError(502, "Couldn't delete the file from storage. Try again.");
  }
  await Resume.deleteOne({ _id: resume._id });
  // Templates that used it as their default simply have no default any more.
  await Template.updateMany({ userId, defaultResumeId: resume._id }, { $set: { defaultResumeId: null } });
  // Email history keeps its attachment metadata (file name, size) for the record.
  res.json({ success: true });
}

// ---- Categories ----

async function seedCategories(userId) {
  const claimed = await User.updateOne({ _id: userId, resumeCategoriesSeeded: { $ne: true } }, { $set: { resumeCategoriesSeeded: true } });
  if (claimed.modifiedCount !== 1) return;
  await ResumeCategory.insertMany(
    DEFAULT_RESUME_CATEGORIES.map((name) => ({ userId, name, nameKey: name.toLowerCase() })),
    { ordered: false },
  ).catch((err) => {
    if (err?.code !== 11000 && !err?.writeErrors) throw err;
  });
}

async function categoriesWithCounts(userId) {
  const [cats, counts] = await Promise.all([
    ResumeCategory.find({ userId }).sort({ name: 1 }),
    Resume.aggregate([{ $match: { userId, deletingAt: null } }, { $group: { _id: "$category", count: { $sum: 1 } } }]),
  ]);
  const byName = new Map(counts.map((c) => [c._id, c.count]));
  return cats.map((c) => ({ ...c.toJSON(), resumeCount: byName.get(c.name) ?? 0 }));
}

export async function listCategories(req, res) {
  await seedCategories(req.user._id);
  res.json({ success: true, categories: await categoriesWithCounts(req.user._id) });
}

export async function createCategory(req, res) {
  const { name } = req.body;
  if (await ResumeCategory.exists({ userId: req.user._id, nameKey: name.toLowerCase() })) {
    throw new AppError(409, "A category with this name already exists");
  }
  const category = await ResumeCategory.create({ userId: req.user._id, name, nameKey: name.toLowerCase() });
  res.status(201).json({ success: true, category: { ...category.toJSON(), resumeCount: 0 } });
}

export async function renameCategory(req, res) {
  const userId = req.user._id;
  const category = await ResumeCategory.findOne({ _id: req.params.id, userId });
  if (!category) throw notFound("Category");
  const { name } = req.body;
  if (await ResumeCategory.exists({ userId, nameKey: name.toLowerCase(), _id: { $ne: category._id } })) {
    throw new AppError(409, "A category with this name already exists");
  }
  const old = category.name;
  category.name = name;
  category.nameKey = name.toLowerCase();
  await category.save();
  await Resume.updateMany({ userId, category: old }, { $set: { category: name } });
  res.json({ success: true, categories: await categoriesWithCounts(userId) });
}

export async function deleteCategory(req, res) {
  const userId = req.user._id;
  const category = await ResumeCategory.findOneAndDelete({ _id: req.params.id, userId });
  if (!category) throw notFound("Category");
  // Resumes are kept; they just become uncategorised.
  await Resume.updateMany({ userId, category: category.name }, { $set: { category: "" } });
  res.json({ success: true, categories: await categoriesWithCounts(userId) });
}
