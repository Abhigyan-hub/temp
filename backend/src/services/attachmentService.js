import { createHash } from "node:crypto";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { Resume } from "../models/Resume.js";
import { AppError } from "../utils/AppError.js";
import { fileNameFor } from "./resumeFiles.js";
import { getStorage, StorageNotFoundError, StorageUnavailableError } from "./storage/index.js";

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** An attachment problem. `transient` = storage hiccup worth retrying; otherwise the file is gone or invalid. */
export class AttachmentError extends AppError {
  constructor(status, message, { transient = false } = {}) {
    super(status, message);
    this.transient = transient;
  }
}

const uniqueIds = (ids) => [...new Set((ids ?? []).map(String))];

/**
 * Check that the user owns every resume, none is being deleted, and the limits hold.
 * Uses metadata only (no storage reads), so it's cheap enough for scheduling.
 */
export async function resolveResumes(userId, resumeIds) {
  const ids = uniqueIds(resumeIds);
  if (ids.length === 0) return [];
  if (ids.length > env.ATTACHMENT_MAX_COUNT) {
    throw new AttachmentError(400, `Attach at most ${env.ATTACHMENT_MAX_COUNT} resumes`);
  }
  if (!ids.every((id) => mongoose.isValidObjectId(id))) throw new AttachmentError(400, "Invalid resume id");

  const found = await Resume.find({ _id: { $in: ids }, userId, deletingAt: null });
  const byId = new Map(found.map((r) => [String(r._id), r]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length) {
    throw new AttachmentError(404, `${missing.length === 1 ? "A selected resume is" : `${missing.length} selected resumes are`} no longer in your Resume Library`);
  }
  const resumes = ids.map((id) => byId.get(id));
  const total = resumes.reduce((sum, r) => sum + r.fileSize, 0);
  if (total > env.attachmentMaxTotalBytes) {
    throw new AttachmentError(400, `Attachments total ${mb(total)}; the limit is ${mb(env.attachmentMaxTotalBytes)}`);
  }
  return resumes;
}

/** Metadata recorded on email history and returned with schedules. */
export const attachmentMeta = (r) => ({
  resumeId: r._id,
  fileName: fileNameFor(r),
  displayName: r.name,
  fileType: r.fileType,
  fileSize: r.fileSize,
});

function storageOrThrow() {
  try {
    return getStorage();
  } catch (err) {
    if (err instanceof StorageUnavailableError) throw new AttachmentError(503, err.message, { transient: true });
    throw err;
  }
}

/** Cheap existence check (no download) used when scheduling. */
export async function verifyStored(resumes) {
  if (resumes.length === 0) return;
  const storage = storageOrThrow();
  for (const r of resumes) {
    if (!(await storage.exists(r.storageKey))) {
      throw new AttachmentError(410, `"${fileNameFor(r)}" is missing from storage. Re-upload it to the Resume Library.`);
    }
  }
}

/**
 * Fetch the files for an email from private storage and verify them byte-for-byte.
 * Returns { files: nodemailer attachments, meta } or throws AttachmentError before anything is sent.
 * The buffers are reused for every recipient of a bulk send.
 */
export async function loadAttachments(userId, resumeIds) {
  const resumes = await resolveResumes(userId, resumeIds);
  if (resumes.length === 0) return { files: [], meta: [] };

  const storage = storageOrThrow();
  const files = await Promise.all(
    resumes.map(async (r) => {
      let content;
      try {
        content = await storage.getBuffer(r.storageKey);
      } catch (err) {
        if (err instanceof StorageNotFoundError) {
          throw new AttachmentError(410, `"${fileNameFor(r)}" is missing from storage. Re-upload it to the Resume Library.`);
        }
        console.error(`Attachment read failed for resume ${r._id}:`, err?.name ?? err);
        throw new AttachmentError(502, `Couldn't read "${fileNameFor(r)}" from storage. Try again shortly.`, { transient: true });
      }
      const hash = createHash("sha256").update(content).digest("hex");
      if (content.length !== r.fileSize || hash !== r.sha256) {
        throw new AttachmentError(409, `"${fileNameFor(r)}" in storage doesn't match the uploaded file. Re-upload it.`);
      }
      return { filename: fileNameFor(r), content, contentType: r.mimeType };
    }),
  );
  return { files, meta: resumes.map(attachmentMeta) };
}
