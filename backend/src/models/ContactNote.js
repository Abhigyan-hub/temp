import mongoose from "mongoose";
import { toJSONPlugin } from "./plugins.js";

const contactNoteSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    contactId: { type: mongoose.Schema.Types.ObjectId, ref: "Contact", required: true },
    text: { type: String, required: true, maxlength: 5000 },
    // Earlier versions of this note, oldest first.
    versions: {
      type: [{ _id: false, text: String, savedAt: Date }],
      default: [],
    },
    // Soft delete: hidden from the UI, kept for the audit trail.
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

contactNoteSchema.index({ userId: 1, contactId: 1, updatedAt: -1 });

contactNoteSchema.plugin(toJSONPlugin);

export const ContactNote = mongoose.model("ContactNote", contactNoteSchema);
