import mongoose from "mongoose";
import { toJSONPlugin } from "./plugins.js";

const templateSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    name: { type: String, required: true, trim: true, maxlength: 150 },
    subject: { type: String, required: true, trim: true, maxlength: 300 },
    body: { type: String, required: true, maxlength: 20000 },
    category: { type: String, trim: true, maxlength: 80, default: "General" },
    isFavorite: { type: Boolean, default: false },
    // Preselected in Compose when this template is chosen. Always optional and removable.
    defaultResumeId: { type: mongoose.Schema.Types.ObjectId, ref: "Resume", default: null },
  },
  { timestamps: true },
);

templateSchema.index({ userId: 1, createdAt: 1 });

templateSchema.plugin(toJSONPlugin);

export const Template = mongoose.model("Template", templateSchema);
