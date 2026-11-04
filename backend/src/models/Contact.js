import mongoose from "mongoose";
import { computeContactStatus, CONTACT_INTEL_STATUSES } from "../shared/contactStatus.js";
import { toJSONPlugin } from "./plugins.js";

export const CONTACT_STATUSES = ["Pending", "Scheduled", "Sent", "Failed"];

const contactSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    serialNo: { type: Number, required: true },
    name: { type: String, trim: true, maxlength: 150, default: "" },
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: 254 },
    title: { type: String, trim: true, maxlength: 150, default: "" },
    company: { type: String, trim: true, maxlength: 150, default: "" },
    category: { type: String, trim: true, maxlength: 80, default: "Uncategorized" },
    notes: { type: String, maxlength: 5000, default: "" },
    // When `notes` last changed (UTC). Null when there are no notes. Unrelated edits leave it alone.
    noteUpdatedAt: { type: Date, default: null },
    // The free-text `notes` field has been copied into ContactNote.
    notesMigrated: { type: Boolean, default: false },
    isBlocked: { type: Boolean, default: false },
    // Why and how long. blockedUntil null = until manually unblocked; past dates lapse automatically.
    blockReason: { type: String, trim: true, maxlength: 500, default: "" },
    blockedAt: { type: Date, default: null },
    blockedUntil: { type: Date, default: null },
    emailStatus: { type: String, enum: CONTACT_STATUSES, default: "Pending" },
    lastEmailedAt: { type: Date },

    // ---- Deliverability. Recomputed into contactStatus on every save. ----
    contactStatus: { type: String, enum: CONTACT_INTEL_STATUSES, default: "Unknown" },
    // Valid only after evidence (a reply, or the user said so). SMTP acceptance doesn't count.
    emailValidity: { type: String, enum: ["Unknown", "Valid", "Invalid"], default: "Unknown" },
    // Last known state of the latest email: Accepted = the SMTP server took it, nothing more.
    deliveryStatus: { type: String, enum: ["None", "Accepted", "Failed", "Bounced"], default: "None" },
    bounceStatus: { type: String, enum: ["None", "Soft", "Hard", "Temporary", "Rejected"], default: "None" },
    bounceReason: { type: String, maxlength: 500, default: "" },
    replyStatus: { type: String, enum: ["None", "Replied", "Auto Replied"], default: "None" },
    unsubscribed: { type: Boolean, default: false },
    softBounceCount: { type: Number, default: 0 },
    softBounceRetryAt: { type: Date, default: null },

    // ---- Counters (send attempts, not deliveries). ----
    totalEmailsSent: { type: Number, default: 0 },
    acceptedCount: { type: Number, default: 0 },
    failedCount: { type: Number, default: 0 },
    hardBounceCount: { type: Number, default: 0 },
    softBounceTotal: { type: Number, default: 0 },
    replyCount: { type: Number, default: 0 },

    lastEmailStatus: { type: String, default: "" },
    lastEmailReceivedAt: { type: Date, default: null },
    lastRepliedAt: { type: Date, default: null },
    lastBounceAt: { type: Date, default: null },
    lastFollowUpAt: { type: Date, default: null },
    nextFollowUpAt: { type: Date, default: null },
    lastActivityAt: { type: Date, default: null },

    // Previous addresses, so old email records stay understandable after a correction.
    addressHistory: {
      type: [
        {
          _id: false,
          email: String,
          status: String,
          reason: String,
          changedAt: Date,
        },
      ],
      default: [],
    },
    // Existing contacts get their counters and timeline from EmailHistory once (see contactIntel).
    intelVersion: { type: Number, default: 0 },
  },
  { timestamps: true },
);

// One contact per email address per user — the basis of duplicate-skipping on import.
contactSchema.index({ userId: 1, email: 1 }, { unique: true });
contactSchema.index({ userId: 1, category: 1 });
contactSchema.index({ userId: 1, serialNo: 1 });
contactSchema.index({ userId: 1, company: 1 });
contactSchema.index({ userId: 1, contactStatus: 1 });
contactSchema.index({ userId: 1, nextFollowUpAt: 1 });
contactSchema.index({ isBlocked: 1, blockedUntil: 1 });

contactSchema.pre("save", function () {
  this.contactStatus = computeContactStatus(this);
});

contactSchema.plugin(toJSONPlugin);

export const Contact = mongoose.model("Contact", contactSchema);
