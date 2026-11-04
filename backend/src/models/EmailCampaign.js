import mongoose from "mongoose";
import { toJSONPlugin } from "./plugins.js";

export const CAMPAIGN_STATUSES = ["Queued", "Running", "Completed", "Cancelled", "Failed"];
export const RECIPIENT_STATUSES = ["Waiting", "Sending", "Accepted", "Failed", "Skipped", "Cancelled"];

// One "Send" click. Progress lives here, not in the browser, so a refresh loses nothing.
const emailCampaignSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    campaignName: { type: String, trim: true, maxlength: 200, default: "" },
    templateId: { type: mongoose.Schema.Types.ObjectId, ref: "Template", required: true },
    resumeIds: { type: [mongoose.Schema.Types.ObjectId], ref: "Resume", default: [] },
    // Null = whatever the user's sending mode resolves to; "system" is stored as usesSystem.
    emailAccountId: { type: mongoose.Schema.Types.ObjectId, ref: "EmailAccount", default: null },
    usesSystem: { type: Boolean, default: false },
    senderEmail: { type: String, default: "" },
    status: { type: String, enum: CAMPAIGN_STATUSES, default: "Queued" },
    statusMessage: { type: String, default: "" },
    totalRecipients: { type: Number, required: true },
    processedCount: { type: Number, default: 0 },
    acceptedCount: { type: Number, default: 0 },
    failedCount: { type: Number, default: 0 },
    skippedCount: { type: Number, default: 0 },
    dryRun: { type: Boolean, default: false },
    // Same request twice (double click, network retry) returns the same campaign.
    clientRequestId: { type: String, maxlength: 80 },
    cancelRequested: { type: Boolean, default: false },
    lockedBy: { type: String, default: "" },
    heartbeatAt: { type: Date, default: null },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

emailCampaignSchema.index({ userId: 1, createdAt: -1 });
emailCampaignSchema.index({ status: 1, heartbeatAt: 1 });
emailCampaignSchema.index(
  { userId: 1, clientRequestId: 1 },
  { unique: true, partialFilterExpression: { clientRequestId: { $type: "string" } } },
);

emailCampaignSchema.plugin(toJSONPlugin);

export const EmailCampaign = mongoose.model("EmailCampaign", emailCampaignSchema);

const emailCampaignRecipientSchema = new mongoose.Schema(
  {
    campaignId: { type: mongoose.Schema.Types.ObjectId, ref: "EmailCampaign", required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    contactId: { type: mongoose.Schema.Types.ObjectId, ref: "Contact", required: true },
    position: { type: Number, required: true },
    recipientEmail: { type: String, required: true },
    recipientName: { type: String, default: "" },
    company: { type: String, default: "" },
    status: { type: String, enum: RECIPIENT_STATUSES, default: "Waiting" },
    errorMessage: { type: String, default: "" },
    // Worth retrying: temporary server errors, login / network problems, interrupted sends.
    retryable: { type: Boolean, default: false },
    messageId: { type: String, default: "" },
    historyId: { type: mongoose.Schema.Types.ObjectId, ref: "EmailHistory" },
    // Set later by inbox sync: bounced / replied. Accepted alone never means delivered.
    outcome: { type: String, default: "" },
    attempts: { type: Number, default: 0 },
    sentAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// A contact appears once per campaign: the core duplicate guard.
emailCampaignRecipientSchema.index({ campaignId: 1, contactId: 1 }, { unique: true });
emailCampaignRecipientSchema.index({ campaignId: 1, status: 1, position: 1 });
emailCampaignRecipientSchema.index({ campaignId: 1, updatedAt: 1 });
emailCampaignRecipientSchema.index({ userId: 1, messageId: 1 });

emailCampaignRecipientSchema.plugin(toJSONPlugin);

export const EmailCampaignRecipient = mongoose.model("EmailCampaignRecipient", emailCampaignRecipientSchema);
