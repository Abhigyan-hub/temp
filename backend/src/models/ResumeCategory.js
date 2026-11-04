import mongoose from "mongoose";
import { toJSONPlugin } from "./plugins.js";

export const DEFAULT_RESUME_CATEGORIES = [
  "MERN Stack Developer",
  "Full Stack Developer",
  "Frontend Developer",
  "React Developer",
  "Software Developer",
  "AI/ML Developer",
  "General Resume",
];

// Each user's own, editable list. The defaults above are only a starting point.
const resumeCategorySchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    nameKey: { type: String, required: true }, // lowercase, for case-insensitive uniqueness
  },
  { timestamps: true },
);

resumeCategorySchema.index({ userId: 1, nameKey: 1 }, { unique: true });
resumeCategorySchema.plugin(toJSONPlugin);
resumeCategorySchema.set("toJSON", {
  versionKey: false,
  transform: (_doc, ret) => {
    ret.id = String(ret._id);
    delete ret._id;
    delete ret.userId;
    delete ret.nameKey;
    return ret;
  },
});

export const ResumeCategory = mongoose.model("ResumeCategory", resumeCategorySchema);
