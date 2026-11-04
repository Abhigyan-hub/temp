import mongoose from "mongoose";
import { toJSONPlugin } from "./plugins.js";

export const SCHEDULE_STATUSES = ["Pending", "Processing", "Sent", "Failed", "Cancelled"];

// One document per recipient: each delivery is claimed, sent and recorded independently,
// so a crash mid-batch never re-sends to recipients that already went out.
const scheduledEmailSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    contactId: { type: mongoose.Schema.Types.ObjectId, ref: "Contact", required: true },
    templateId: { type: mongoose.Schema.Types.ObjectId, ref: "Template", required: true },
    // Resume Library files to attach. Resolved from storage when the job runs.
    resumeIds: { type: [mongoose.Schema.Types.ObjectId], ref: "Resume", default: [] },
    // The sender chosen in Compose. Null + usesSystem=false = the user's sending mode at run time.
    emailAccountId: { type: mongoose.Schema.Types.ObjectId, ref: "EmailAccount", default: null },
    usesSystem: { type: Boolean, default: false },
    // Groups the schedules created together from one compose action.
    batchId: { type: String, default: "" },
    // Stored in UTC; the client converts the user's local date/time before sending.
    scheduledAt: { type: Date, required: true },
    timezone: { type: String, default: "UTC", maxlength: 64 },
    status: { type: String, enum: SCHEDULE_STATUSES, default: "Pending" },
    comments: { type: String, maxlength: 1000, default: "" },
    attempts: { type: Number, default: 0 },
    lockedAt: { type: Date },
    lockedBy: { type: String },
    // Set just before handing the message to SMTP; see schedulerService for crash recovery.
    sendingStartedAt: { type: Date },
    processedAt: { type: Date },
    errorMessage: { type: String, default: "" },
    historyId: { type: mongoose.Schema.Types.ObjectId, ref: "EmailHistory" },
  },
  { timestamps: true },
);

scheduledEmailSchema.index({ status: 1, scheduledAt: 1 });
scheduledEmailSchema.index({ userId: 1, scheduledAt: 1 });
scheduledEmailSchema.index({ resumeIds: 1, status: 1 });
// Prevent scheduling the same email to the same contact for the same moment twice.
scheduledEmailSchema.index(
  { userId: 1, contactId: 1, templateId: 1, scheduledAt: 1 },
  { unique: true, partialFilterExpression: { status: { $eq: "Pending" } } },
);

scheduledEmailSchema.plugin(toJSONPlugin);

export const ScheduledEmail = mongoose.model("ScheduledEmail", scheduledEmailSchema);
