import mongoose from "mongoose";
import { toJSONPlugin } from "./plugins.js";

const emailHistorySchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    contactId: { type: mongoose.Schema.Types.ObjectId, ref: "Contact" },
    templateId: { type: mongoose.Schema.Types.ObjectId, ref: "Template" },
    scheduleId: { type: mongoose.Schema.Types.ObjectId, ref: "ScheduledEmail" },
    recipient: { type: String, required: true, lowercase: true, trim: true },
    subject: { type: String, required: true },
    body: { type: String, default: "" },
    status: { type: String, enum: ["Sent", "Failed"], required: true },
    errorMessage: { type: String, default: "" },
    messageId: { type: String, default: "" },
    source: { type: String, enum: ["manual", "campaign", "scheduled", "test"], default: "manual" },
    // Built but never handed to Gmail (server running with EMAIL_TRANSPORT=json).
    dryRun: { type: Boolean, default: false },
    templateName: { type: String, default: "" },
    campaignId: { type: mongoose.Schema.Types.ObjectId, ref: "EmailCampaign" },
    // Which sender was used: a user's EmailAccount, or null for the system account.
    emailAccountId: { type: mongoose.Schema.Types.ObjectId, ref: "EmailAccount", default: null },
    senderEmail: { type: String, default: "" },
    // Why SMTP refused it: hard | temporary | rejected | sender | network | auth | message | other
    failureKind: { type: String, default: "" },
    // What came back later (inbox sync). "Sent" only ever means the SMTP server accepted it.
    outcome: { type: String, default: "" },
    outcomeAt: { type: Date, default: null },
    // What was attached (metadata only — the file stays in the Resume Library's storage).
    attachments: {
      type: [
        {
          _id: false,
          resumeId: { type: mongoose.Schema.Types.ObjectId, ref: "Resume" },
          fileName: String,
          displayName: String,
          fileType: String,
          fileSize: Number,
        },
      ],
      default: [],
    },
    sentAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

emailHistorySchema.index({ userId: 1, sentAt: -1 });
emailHistorySchema.index({ messageId: 1 });
emailHistorySchema.index({ recipient: 1, sentAt: -1 });
emailHistorySchema.index({ userId: 1, contactId: 1, templateId: 1, sentAt: -1 });

emailHistorySchema.plugin(toJSONPlugin);

export const EmailHistory = mongoose.model("EmailHistory", emailHistorySchema);
