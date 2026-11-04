import mongoose from "mongoose";
import { toJSONPlugin } from "./plugins.js";

// Metadata only: the file itself lives in private object storage under `storageKey`.
const resumeSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    originalFileName: { type: String, required: true, maxlength: 255 },
    storageKey: { type: String, required: true },
    fileType: { type: String, enum: ["pdf", "docx", "doc"], required: true },
    mimeType: { type: String, required: true },
    fileSize: { type: Number, required: true, min: 1 },
    // Content hash: duplicate detection and an integrity check before attaching.
    sha256: { type: String, required: true },
    category: { type: String, trim: true, maxlength: 80, default: "" },
    description: { type: String, trim: true, maxlength: 1000, default: "" },
    labels: { type: [String], default: [] },
    // Set while a delete is in progress so new schedules can't pick the file up.
    deletingAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: "uploadedAt", updatedAt: "updatedAt" } },
);

resumeSchema.index({ userId: 1, uploadedAt: -1 });
resumeSchema.index({ userId: 1, sha256: 1 }, { unique: true });
resumeSchema.index({ storageKey: 1 }, { unique: true });

resumeSchema.plugin(toJSONPlugin);
resumeSchema.set("toJSON", {
  versionKey: false,
  transform: (_doc, ret) => {
    ret.id = String(ret._id);
    delete ret._id;
    delete ret.userId;
    delete ret.storageKey; // internal; files are only reachable through the authenticated API
    delete ret.sha256;
    delete ret.deletingAt;
    return ret;
  },
});

export const Resume = mongoose.model("Resume", resumeSchema);
