import mongoose from "mongoose";

// Where each mailbox's IMAP sync got to, and a lease so only one instance syncs it at a time.
const mailboxSyncStateSchema = new mongoose.Schema(
  {
    accountKey: { type: String, required: true },
    uidValidity: { type: String, default: "" },
    lastUid: { type: Number, default: 0 },
    lastSyncAt: { type: Date, default: null },
    lastError: { type: String, default: "" },
    lastMatched: { type: Number, default: 0 },
    lockedUntil: { type: Date, default: null },
  },
  { timestamps: true },
);

mailboxSyncStateSchema.index({ accountKey: 1 }, { unique: true });

export const MailboxSyncState = mongoose.model("MailboxSyncState", mailboxSyncStateSchema);
