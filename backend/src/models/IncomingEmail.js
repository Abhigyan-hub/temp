import mongoose from "mongoose";
import { toJSONPlugin } from "./plugins.js";

export const INCOMING_CLASSIFICATIONS = [
  "hard_bounce",
  "soft_bounce",
  "temporary_rejection",
  "rejected",
  "complaint",
  "auto_reply",
  "out_of_office",
  "human_reply",
];

// Replies and bounce notifications tied to an email MailFlow sent. Unrelated inbox mail is never stored.
const incomingEmailSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    accountKey: { type: String, required: true }, // "system" or an EmailAccount id
    senderEmail: { type: String, lowercase: true, trim: true, default: "" },
    recipientEmail: { type: String, lowercase: true, trim: true, default: "" },
    subject: { type: String, default: "" },
    bodyPreview: { type: String, default: "" },
    messageId: { type: String, required: true },
    inReplyTo: { type: String, default: "" },
    references: { type: [String], default: [] },
    classification: { type: String, enum: INCOMING_CLASSIFICATIONS, required: true },
    // How it was tied to the contact: original-message-id | in-reply-to | references | recipient | sender
    matchedBy: { type: String, default: "" },
    // Delivery status notification details, when present.
    bounce: {
      finalRecipient: String,
      action: String,
      status: String,
      diagnostic: String,
      structured: Boolean,
    },
    relatedContactId: { type: mongoose.Schema.Types.ObjectId, ref: "Contact" },
    relatedEmailId: { type: mongoose.Schema.Types.ObjectId, ref: "EmailHistory" },
    receivedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

// The same message is never processed twice, even across instances.
incomingEmailSchema.index({ userId: 1, messageId: 1 }, { unique: true });
incomingEmailSchema.index({ userId: 1, relatedContactId: 1, receivedAt: -1 });
incomingEmailSchema.index({ userId: 1, classification: 1, receivedAt: -1 });

incomingEmailSchema.plugin(toJSONPlugin);

export const IncomingEmail = mongoose.model("IncomingEmail", incomingEmailSchema);
