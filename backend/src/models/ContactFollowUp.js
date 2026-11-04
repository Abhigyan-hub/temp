import mongoose from "mongoose";
import { toJSONPlugin } from "./plugins.js";

const contactFollowUpSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    contactId: { type: mongoose.Schema.Types.ObjectId, ref: "Contact", required: true },
    dueAt: { type: Date, required: true },
    note: { type: String, trim: true, maxlength: 1000, default: "" },
    status: { type: String, enum: ["Pending", "Done", "Cancelled"], default: "Pending" },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

contactFollowUpSchema.index({ userId: 1, status: 1, dueAt: 1 });
contactFollowUpSchema.index({ userId: 1, contactId: 1, dueAt: -1 });

contactFollowUpSchema.plugin(toJSONPlugin);

export const ContactFollowUp = mongoose.model("ContactFollowUp", contactFollowUpSchema);
