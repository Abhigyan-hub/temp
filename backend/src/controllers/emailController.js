import { z } from "zod";
import { env } from "../config/env.js";
import { Contact } from "../models/Contact.js";
import { EmailHistory } from "../models/EmailHistory.js";
import { ScheduledEmail } from "../models/ScheduledEmail.js";
import { Template } from "../models/Template.js";
import { loadAttachments } from "../services/attachmentService.js";
import { releaseExpiredBlocks, restrictionFor } from "../services/blockService.js";
import { deliverToContact, isDryRun, sendMail, senderNameFor, sentInLast24h } from "../services/emailService.js";
import { resolveSender } from "../services/senderService.js";
import { AppError, notFound } from "../utils/AppError.js";
import { objectId } from "../utils/validators.js";

// Re-sending the same template to the same contact inside this window is treated as an accident.
const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One bulk send per user at a time (per instance) so double-clicks can't start parallel batches.
const inFlight = new Set();

export const schemas = {
  send: z.object({
    templateId: objectId,
    contactIds: z
      .array(objectId)
      .min(1, "Select at least one contact")
      .max(env.MAX_RECIPIENTS_PER_SEND, `Send to at most ${env.MAX_RECIPIENTS_PER_SEND} contacts at a time`),
    resumeIds: z.array(objectId).max(env.ATTACHMENT_MAX_COUNT, `Attach at most ${env.ATTACHMENT_MAX_COUNT} resumes`).optional().default([]),
    emailAccountId: z.string().max(40).optional(), // "system", an account id, or empty for the user's mode
  }),
  history: z.object({
    status: z.enum(["Sent", "Failed"]).optional(),
    contactId: objectId.optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  }),
};

export async function send(req, res) {
  const user = req.user;
  const key = String(user._id);
  if (inFlight.has(key)) throw new AppError(409, "A send is already in progress. Wait for it to finish.");
  inFlight.add(key);

  try {
    const contactIds = [...new Set(req.body.contactIds)];
    const template = await Template.findOne({ _id: req.body.templateId, userId: user._id });
    if (!template) throw notFound("Template");

    await releaseExpiredBlocks({ userId: user._id, _id: { $in: contactIds } });
    const contacts = await Contact.find({ _id: { $in: contactIds }, userId: user._id });
    const byId = new Map(contacts.map((c) => [String(c._id), c]));

    const remaining = env.DAILY_SEND_LIMIT - (await sentInLast24h(user._id));
    if (remaining <= 0) {
      throw new AppError(429, `Daily limit of ${env.DAILY_SEND_LIMIT} emails reached. Try again tomorrow.`);
    }

    const sender = await resolveSender(user, req.body.emailAccountId);

    // Fetch and verify every attachment before the first email goes out: a recipient
    // never gets a message with some of the selected files silently missing.
    const attachments = await loadAttachments(user._id, req.body.resumeIds);

    const recent = await EmailHistory.find({
      userId: user._id,
      templateId: template._id,
      contactId: { $in: contacts.map((c) => c._id) },
      status: "Sent",
      sentAt: { $gte: new Date(Date.now() - DUPLICATE_WINDOW_MS) },
    }).select("contactId");
    const recentlySent = new Set(recent.map((h) => String(h.contactId)));

    const results = [];
    let attempted = 0;
    for (const id of contactIds) {
      const contact = byId.get(id);
      const base = { contactId: id, email: contact?.email ?? "", name: contact?.name ?? "" };
      if (!contact) {
        results.push({ ...base, status: "Skipped", error: "Contact not found" });
        continue;
      }
      const restriction = restrictionFor(contact, user.settings?.timezone);
      if (restriction) {
        results.push({
          ...base,
          status: "Skipped",
          error: restriction.message,
          restriction: restriction.code,
          blockReason: restriction.code === "blocked" ? contact.blockReason : restriction.message,
          blockedUntil: contact.blockedUntil,
        });
        continue;
      }
      if (recentlySent.has(id)) {
        results.push({ ...base, status: "Skipped", error: "Already sent this template in the last 10 minutes" });
        continue;
      }
      if (attempted >= remaining) {
        results.push({ ...base, status: "Skipped", error: "Daily send limit reached" });
        continue;
      }

      if (attempted > 0 && env.SEND_DELAY_MS) await sleep(env.SEND_DELAY_MS);
      attempted++;
      const history = await deliverToContact({ user, contact, template, source: "manual", attachments, sender });
      results.push({ ...base, status: history.status, error: history.errorMessage || undefined });
    }

    const count = (s) => results.filter((r) => r.status === s).length;
    res.json({
      success: true,
      sent: count("Sent"),
      failed: count("Failed"),
      skipped: count("Skipped"),
      attachments: attachments.meta,
      // True when this server builds emails without delivering them (EMAIL_TRANSPORT=json).
      dryRun: isDryRun(),
      results,
    });
  } finally {
    inFlight.delete(key);
  }
}

/** Send a test email to the signed-in user's own address. */
export async function sendTest(req, res) {
  const user = req.user;
  const sender = await resolveSender(user);
  const result = await sendMail({
    to: user.email,
    subject: "MailFlow test email",
    text: `Hi ${user.name},\n\nThis is a test email from MailFlow, sent through ${sender.fromEmail}. If you can read this, sending works.\n\n— MailFlow`,
    fromName: sender.fromName || senderNameFor(user),
    sender,
  });
  await EmailHistory.create({
    userId: user._id,
    recipient: user.email,
    subject: "MailFlow test email",
    emailAccountId: sender.accountId,
    senderEmail: sender.fromEmail,
    status: result.success ? "Sent" : "Failed",
    errorMessage: result.success ? "" : result.error,
    messageId: result.messageId ?? "",
    source: "test",
    dryRun: isDryRun(),
  });
  if (!result.success) throw new AppError(502, result.error);
  res.json({
    success: true,
    dryRun: isDryRun(),
    message: isDryRun()
      ? `Dry run: built a test email for ${user.email} but did not send it (EMAIL_TRANSPORT=json)`
      : `Test email sent to ${user.email}`,
  });
}

export async function history(req, res) {
  const { status, contactId, limit } = req.validatedQuery;
  const filter = { userId: req.user._id };
  if (status) filter.status = status;
  if (contactId) filter.contactId = contactId;
  const items = await EmailHistory.find(filter).sort({ sentAt: -1 }).limit(limit).select("-body");
  res.json({ success: true, history: items });
}

export async function stats(req, res) {
  const userId = req.user._id;
  const tz = req.user.settings?.timezone || "UTC";
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [contactAgg, historyAgg, pendingSchedules, daily, categories, recent, sentLast24h] = await Promise.all([
    Contact.aggregate([
      { $match: { userId } },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          blocked: { $sum: { $cond: ["$isBlocked", 1, 0] } },
          notContacted: {
            $sum: { $cond: [{ $and: [{ $not: ["$isBlocked"] }, { $eq: ["$emailStatus", "Pending"] }] }, 1, 0] },
          },
        },
      },
    ]),
    EmailHistory.aggregate([
      { $match: { userId, source: { $ne: "test" } } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),
    ScheduledEmail.countDocuments({ userId, status: { $in: ["Pending", "Processing"] } }),
    EmailHistory.aggregate([
      { $match: { userId, source: { $ne: "test" }, sentAt: { $gte: weekAgo } } },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$sentAt", timezone: tz } },
          sent: { $sum: { $cond: [{ $eq: ["$status", "Sent"] }, 1, 0] } },
          failed: { $sum: { $cond: [{ $eq: ["$status", "Failed"] }, 1, 0] } },
        },
      },
    ]),
    Contact.aggregate([
      { $match: { userId } },
      { $group: { _id: "$category", value: { $sum: 1 } } },
      { $sort: { value: -1 } },
    ]),
    EmailHistory.find({ userId }).sort({ sentAt: -1 }).limit(8).select("-body"),
    sentInLast24h(userId),
  ]);

  const c = contactAgg[0] ?? { total: 0, blocked: 0, notContacted: 0 };
  const byStatus = Object.fromEntries(historyAgg.map((h) => [h._id, h.count]));
  const sent = byStatus.Sent ?? 0;
  const failed = byStatus.Failed ?? 0;

  res.json({
    success: true,
    stats: {
      totalContacts: c.total,
      blockedContacts: c.blocked,
      notContacted: c.notContacted,
      totalEmails: sent + failed,
      sent,
      failed,
      successRate: sent + failed ? Math.round((sent / (sent + failed)) * 100) : 0,
      pendingSchedules,
      sentLast24h,
      dailyLimit: env.DAILY_SEND_LIMIT,
      emailMode: isDryRun() ? "dry-run" : "live",
      timezone: tz,
      daily: daily.map((d) => ({ date: d._id, sent: d.sent, failed: d.failed })),
      categories: categories.map((x) => ({ name: x._id || "Uncategorized", value: x.value })),
      recent,
    },
  });
}
