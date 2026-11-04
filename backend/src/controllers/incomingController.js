import { z } from "zod";
import { env } from "../config/env.js";
import { IncomingEmail, INCOMING_CLASSIFICATIONS } from "../models/IncomingEmail.js";
import { syncAllMailboxes, syncStatus } from "../services/incoming/imapSync.js";
import { AppError } from "../utils/AppError.js";

export const schemas = {
  list: z.object({
    classification: z.enum(INCOMING_CLASSIFICATIONS).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
};

export async function list(req, res) {
  const { classification, limit } = req.validatedQuery;
  const messages = await IncomingEmail.find({ userId: req.user._id, ...(classification ? { classification } : {}) })
    .sort({ receivedAt: -1 })
    .limit(limit);
  res.json({ success: true, messages });
}

export async function status(req, res) {
  res.json({ success: true, enabled: env.INBOX_SYNC_ENABLED, intervalMinutes: env.INBOX_SYNC_INTERVAL_MIN, mailboxes: await syncStatus(req.user._id) });
}

/** "Sync now": the system mailbox plus this user's own mailboxes. */
export async function sync(req, res) {
  if (!env.INBOX_SYNC_ENABLED) throw new AppError(400, "Inbox sync is turned off on this server (INBOX_SYNC_ENABLED=false).");
  const system = await syncAllMailboxes({ onlySystemAnd: req.user._id });
  const stored = system.reduce((n, r) => n + (r.stored ?? 0), 0);
  const scanned = system.reduce((n, r) => n + (r.scanned ?? 0), 0);
  const errors = system.filter((r) => r.error).map((r) => r.error);
  res.json({ success: true, scanned, stored, errors, mailboxes: await syncStatus(req.user._id) });
}
