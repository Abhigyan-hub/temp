import mongoose from "mongoose";
import { toJSONPlugin } from "./plugins.js";

// Append-only audit trail shown as the contact's timeline.
const contactActivitySchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    contactId: { type: mongoose.Schema.Types.ObjectId, ref: "Contact", required: true },
    activityType: { type: String, required: true, maxlength: 40 },
    description: { type: String, required: true, maxlength: 1000 },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    relatedEmailId: { type: mongoose.Schema.Types.ObjectId, ref: "EmailHistory" },
    occurredAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

contactActivitySchema.index({ userId: 1, contactId: 1, occurredAt: -1 });

contactActivitySchema.plugin(toJSONPlugin);

export const ContactActivity = mongoose.model("ContactActivity", contactActivitySchema);
