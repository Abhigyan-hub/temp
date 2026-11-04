import dns from "node:dns/promises";
import { z } from "zod";
import { Contact } from "../models/Contact.js";
import { ContactActivity } from "../models/ContactActivity.js";
import { ContactFollowUp } from "../models/ContactFollowUp.js";
import { ContactNote } from "../models/ContactNote.js";
import { EmailHistory } from "../models/EmailHistory.js";
import { IncomingEmail } from "../models/IncomingEmail.js";
import { Template } from "../models/Template.js";
import { applyEmailChange, logActivity, MANUAL_STATUS_PATCHES } from "../services/contactIntel.js";
import { addNote, deleteNote, editNote, migrateLegacyNote } from "../services/noteService.js";
import { findSpellingSuggestions, isValidEmail, normalizeEmail } from "../shared/contactData.js";
import { CONTACT_INTEL_STATUSES } from "../shared/contactStatus.js";
import { formatDateTime } from "../shared/datetime.js";
import { AppError, notFound } from "../utils/AppError.js";
import { emailField, objectId } from "../utils/validators.js";

const futureDate = z
  .string({ error: "Follow-up date is required" })
  .datetime({ offset: true, message: "Follow-up date must be an ISO date-time" })
  .transform((s) => new Date(s))
  .refine((d) => d.getTime() > Date.now() - 60 * 1000, "Follow-up date is in the past");

const noteText = z.string({ error: "Note text is required" }).trim().min(1, "Note text is required").max(5000);
const optionalDate = z.string().datetime({ offset: true, message: "Use an ISO date-time" }).optional();

export const schemas = {
  checkEmail: z.object({ email: z.string().max(300), excludeId: objectId.optional() }),
  changeEmail: z.object({
    email: emailField,
    // The address is only ever changed on an explicit request from the user.
    confirm: z.literal(true, { error: "Confirm the new email address" }),
  }),
  changeStatus: z.object({
    status: z.enum(CONTACT_INTEL_STATUSES),
    confirm: z.literal(true, { error: "Confirm the status change" }),
    reason: z.string().trim().max(500).optional().default(""),
  }),
  note: z.object({ text: noteText }),
  followUpCreate: z.object({ dueAt: futureDate, note: z.string().trim().max(1000).optional().default("") }),
  followUpUpdate: z.object({
    status: z.enum(["Done", "Cancelled", "Pending"]).optional(),
    dueAt: futureDate.optional(),
    note: z.string().trim().max(1000).optional(),
  }),
  noteParams: z.object({ id: objectId, noteId: objectId }),
  followUpParams: z.object({ id: objectId, followUpId: objectId }),
  analytics: z.object({
    from: optionalDate,
    to: optionalDate,
    category: z.string().trim().max(80).optional(),
    company: z.string().trim().max(150).optional(),
    status: z.enum(CONTACT_INTEL_STATUSES).optional(),
  }),
  timeline: z.object({ limit: z.coerce.number().int().min(1).max(500).default(200) }),
};

const ownContact = async (req) => {
  const contact = await Contact.findOne({ _id: req.params.id, userId: req.user._id });
  if (!contact) throw notFound("Contact");
  return contact;
};

// ---------- email correction ----------

/** Everything the correction dialog shows before saving. Changes nothing. */
export async function checkEmail(req, res) {
  const { email, excludeId } = req.validatedQuery;
  const normalized = normalizeEmail(email);
  const valid = isValidEmail(normalized);
  const owner = valid
    ? await Contact.findOne({ userId: req.user._id, email: normalized, ...(excludeId ? { _id: { $ne: excludeId } } : {}) }).select("name email")
    : null;

  // Domain check: "unknown" (not "no") when DNS itself can't answer.
  let domain = "unknown";
  if (valid) {
    const host = normalized.slice(normalized.lastIndexOf("@") + 1);
    try {
      domain = (await dns.resolveMx(host)).length ? "ok" : "no-mail-server";
    } catch (err) {
      if (err?.code === "ENOTFOUND") domain = "not-found";
      else if (err?.code === "ENODATA") domain = "no-mail-server";
    }
  }
  res.json({
    success: true,
    email: normalized,
    valid,
    duplicate: owner ? { id: String(owner._id), name: owner.name, email: owner.email } : null,
    domain,
    suggestions: findSpellingSuggestions(normalized, "email"),
  });
}

export async function changeEmail(req, res) {
  const contact = await ownContact(req);
  const { email } = req.body;
  if (email === contact.email) throw new AppError(400, "That's already this contact's email address");
  if (await Contact.exists({ userId: req.user._id, email, _id: { $ne: contact._id } })) {
    throw new AppError(409, "Another contact already uses this email");
  }
  const oldEmail = contact.email;
  applyEmailChange(contact, email);
  await contact.save();
  await logActivity({
    userId: req.user._id,
    contactId: contact._id,
    type: "email_changed",
    description: `Email address corrected from ${oldEmail} to ${email}`,
    metadata: { from: oldEmail, to: email },
  });
  res.json({ success: true, contact });
}

/** Manual status correction: always explicit, always on the timeline. Blocking has its own endpoint. */
export async function changeStatus(req, res) {
  const contact = await ownContact(req);
  const { status, reason } = req.body;
  if (status === "Blocked") throw new AppError(400, "Use Block to block a contact, so the reason and duration are recorded");
  const previous = contact.contactStatus;
  contact.set(MANUAL_STATUS_PATCHES[status]);
  if (status !== "Unsubscribed" && contact.unsubscribed && !["Unknown", "Valid"].includes(status)) contact.unsubscribed = false;
  contact.lastActivityAt = new Date();
  await contact.save();
  await logActivity({
    userId: req.user._id,
    contactId: contact._id,
    type: "status_changed",
    description: `Status changed manually from ${previous} to ${contact.contactStatus}${reason ? `: ${reason}` : ""}`,
    metadata: { from: previous, to: contact.contactStatus, reason, manual: true },
  });
  res.json({ success: true, contact });
}

// ---------- profile data ----------

export async function getOne(req, res) {
  res.json({ success: true, contact: await ownContact(req) });
}

export async function activity(req, res) {
  const contact = await ownContact(req);
  const activities = await ContactActivity.find({ userId: req.user._id, contactId: contact._id }).sort({ occurredAt: -1, _id: -1 }).limit(req.validatedQuery.limit);
  res.json({ success: true, activities });
}

export async function emailHistory(req, res) {
  const contact = await ownContact(req);
  const rows = await EmailHistory.find({ userId: req.user._id, contactId: contact._id }).sort({ sentAt: -1 }).limit(500).select("-body");
  // Emails from before template names were recorded.
  const missing = [...new Set(rows.filter((h) => !h.templateName && h.templateId).map((h) => String(h.templateId)))];
  const templates = missing.length ? await Template.find({ userId: req.user._id, _id: { $in: missing } }).select("name") : [];
  const names = new Map(templates.map((t) => [String(t._id), t.name]));
  const history = rows.map((h) => {
    const json = h.toJSON();
    return { ...json, templateName: h.templateName || names.get(String(h.templateId)) || "" };
  });
  res.json({ success: true, history });
}

export async function incoming(req, res) {
  const contact = await ownContact(req);
  const messages = await IncomingEmail.find({ userId: req.user._id, relatedContactId: contact._id }).sort({ receivedAt: -1 }).limit(200);
  res.json({ success: true, messages });
}

// ---------- notes ----------

export async function listNotes(req, res) {
  const contact = await ownContact(req);
  if (!contact.notesMigrated) {
    await migrateLegacyNote(contact);
    await contact.save({ timestamps: false });
  }
  const notes = await ContactNote.find({ userId: req.user._id, contactId: contact._id, deletedAt: null }).sort({ updatedAt: -1 });
  res.json({ success: true, notes });
}

export async function createNote(req, res) {
  const contact = await ownContact(req);
  const note = await addNote(contact, req.body.text);
  res.status(201).json({ success: true, note, contact });
}

const ownNote = async (req) => {
  const note = await ContactNote.findOne({ _id: req.params.noteId, contactId: req.params.id, userId: req.user._id, deletedAt: null });
  if (!note) throw notFound("Note");
  return note;
};

export async function updateNote(req, res) {
  const contact = await ownContact(req);
  const note = await editNote(contact, await ownNote(req), req.body.text);
  res.json({ success: true, note, contact });
}

export async function removeNote(req, res) {
  const contact = await ownContact(req);
  await deleteNote(contact, await ownNote(req));
  res.json({ success: true, contact });
}

// ---------- follow-ups ----------

async function refreshFollowUps(contact) {
  const next = await ContactFollowUp.findOne({ userId: contact.userId, contactId: contact._id, status: "Pending" }).sort({ dueAt: 1 });
  const last = await ContactFollowUp.findOne({ userId: contact.userId, contactId: contact._id, status: "Done" }).sort({ completedAt: -1 });
  contact.nextFollowUpAt = next?.dueAt ?? null;
  contact.lastFollowUpAt = last?.completedAt ?? null;
  contact.lastActivityAt = new Date();
  await contact.save();
}

export async function listFollowUps(req, res) {
  const contact = await ownContact(req);
  const followUps = await ContactFollowUp.find({ userId: req.user._id, contactId: contact._id }).sort({ dueAt: -1 }).limit(200);
  res.json({ success: true, followUps });
}

export async function createFollowUp(req, res) {
  const contact = await ownContact(req);
  const followUp = await ContactFollowUp.create({ userId: req.user._id, contactId: contact._id, dueAt: req.body.dueAt, note: req.body.note });
  await refreshFollowUps(contact);
  await logActivity({
    userId: req.user._id,
    contactId: contact._id,
    type: "followup_added",
    description: `Follow-up set for ${formatDateTime(followUp.dueAt, req.user.settings?.timezone)}${followUp.note ? `: ${followUp.note}` : ""}`,
    metadata: { dueAt: followUp.dueAt },
  });
  res.status(201).json({ success: true, followUp, contact });
}

export async function updateFollowUp(req, res) {
  const contact = await ownContact(req);
  const followUp = await ContactFollowUp.findOne({ _id: req.params.followUpId, contactId: contact._id, userId: req.user._id });
  if (!followUp) throw notFound("Follow-up");
  const { status, dueAt, note } = req.body;
  if (dueAt) followUp.dueAt = dueAt;
  if (note !== undefined) followUp.note = note;
  if (status) {
    followUp.status = status;
    followUp.completedAt = status === "Done" ? new Date() : null;
  }
  await followUp.save();
  await refreshFollowUps(contact);
  const tz = req.user.settings?.timezone;
  const description =
    status === "Done"
      ? "Follow-up completed"
      : status === "Cancelled"
        ? "Follow-up cancelled"
        : `Follow-up changed to ${formatDateTime(followUp.dueAt, tz)}`;
  await logActivity({ userId: req.user._id, contactId: contact._id, type: status === "Done" ? "followup_done" : status === "Cancelled" ? "followup_cancelled" : "followup_changed", description });
  res.json({ success: true, followUp, contact });
}

/** Pending follow-ups for the Contacts dashboard, soonest first (overdue ones included). */
export async function upcomingFollowUps(req, res) {
  const rows = await ContactFollowUp.find({ userId: req.user._id, status: "Pending" }).sort({ dueAt: 1 }).limit(50);
  const contacts = await Contact.find({ userId: req.user._id, _id: { $in: rows.map((f) => f.contactId) } }).select("name email company");
  const byId = new Map(contacts.map((c) => [String(c._id), c]));
  const followUps = rows
    .map((f) => {
      const c = byId.get(String(f.contactId));
      return c ? { ...f.toJSON(), contactId: String(f.contactId), contact: { id: String(c._id), name: c.name, email: c.email, company: c.company } } : null;
    })
    .filter(Boolean);
  res.json({ success: true, followUps });
}

// ---------- analytics ----------

export async function analytics(req, res) {
  const userId = req.user._id;
  const { from, to, category, company, status } = req.validatedQuery;
  const tz = req.user.settings?.timezone || "UTC";

  const contactMatch = { userId };
  if (category) contactMatch.category = category;
  if (company) contactMatch.company = company;
  if (status) contactMatch.contactStatus = status;
  const filtered = !!(category || company || status);

  const range = {};
  if (from) range.$gte = new Date(from);
  if (to) range.$lte = new Date(to);
  const hasRange = Object.keys(range).length > 0;

  // Date and contact filters narrow the email data; contact counts reflect the contact filters.
  const contactIds = filtered ? (await Contact.find(contactMatch).select("_id")).map((c) => c._id) : null;
  const historyMatch = {
    userId,
    source: { $ne: "test" },
    dryRun: { $ne: true },
    ...(hasRange ? { sentAt: range } : {}),
    ...(contactIds ? { contactId: { $in: contactIds } } : {}),
  };
  const incomingMatch = {
    userId,
    ...(hasRange ? { receivedAt: range } : {}),
    ...(contactIds ? { relatedContactId: { $in: contactIds } } : {}),
  };

  const [statusRows, totals, emailsByDay, incomingByDay, incomingTotals, pendingFollowUps, overdueFollowUps, categories, companies] = await Promise.all([
    Contact.aggregate([{ $match: contactMatch }, { $group: { _id: "$contactStatus", count: { $sum: 1 } } }]),
    Contact.aggregate([
      { $match: contactMatch },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          blocked: { $sum: { $cond: ["$isBlocked", 1, 0] } },
          // Emailed, the server accepted it, and nothing has come back yet.
          awaitingReply: {
            $sum: {
              $cond: [
                { $and: [{ $gt: ["$acceptedCount", 0] }, { $eq: ["$replyStatus", "None"] }, { $eq: ["$bounceStatus", "None"] }, { $not: ["$isBlocked"] }, { $not: ["$unsubscribed"] }] },
                1,
                0,
              ],
            },
          },
        },
      },
    ]),
    EmailHistory.aggregate([
      { $match: historyMatch },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$sentAt", timezone: tz } },
          accepted: { $sum: { $cond: [{ $eq: ["$status", "Sent"] }, 1, 0] } },
          failed: { $sum: { $cond: [{ $eq: ["$status", "Failed"] }, 1, 0] } },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    IncomingEmail.aggregate([
      { $match: incomingMatch },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$receivedAt", timezone: tz } },
          bounces: { $sum: { $cond: [{ $in: ["$classification", ["hard_bounce", "soft_bounce", "temporary_rejection", "rejected"]] }, 1, 0] } },
          replies: { $sum: { $cond: [{ $eq: ["$classification", "human_reply"] }, 1, 0] } },
          autoReplies: { $sum: { $cond: [{ $in: ["$classification", ["auto_reply", "out_of_office"]] }, 1, 0] } },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    IncomingEmail.aggregate([{ $match: incomingMatch }, { $group: { _id: "$classification", count: { $sum: 1 } } }]),
    ContactFollowUp.distinct("contactId", { userId, status: "Pending", ...(contactIds ? { contactId: { $in: contactIds } } : {}) }),
    ContactFollowUp.countDocuments({ userId, status: "Pending", dueAt: { $lt: new Date() }, ...(contactIds ? { contactId: { $in: contactIds } } : {}) }),
    Contact.distinct("category", { userId }),
    Contact.distinct("company", { userId }),
  ]);

  const byStatus = Object.fromEntries(CONTACT_INTEL_STATUSES.map((s) => [s, 0]));
  for (const r of statusRows) if (r._id) byStatus[r._id] = r.count;
  const incomingCounts = Object.fromEntries(incomingTotals.map((r) => [r._id, r.count]));
  const accepted = emailsByDay.reduce((n, d) => n + d.accepted, 0);
  const failed = emailsByDay.reduce((n, d) => n + d.failed, 0);
  const t = totals[0] ?? { total: 0, blocked: 0, awaitingReply: 0 };

  res.json({
    success: true,
    analytics: {
      totalContacts: t.total,
      validContacts: byStatus.Valid + byStatus.Replied + byStatus["Auto Replied"],
      invalidContacts: byStatus.Invalid,
      hardBounced: byStatus["Hard Bounced"],
      softBounced: byStatus["Soft Bounced"],
      blocked: t.blocked,
      replied: byStatus.Replied,
      awaitingReply: t.awaitingReply,
      pendingFollowUps: pendingFollowUps.length,
      overdueFollowUps,
      totalEmailsSent: accepted + failed,
      acceptedEmails: accepted,
      failedEmails: failed,
      averagePerContact: t.total ? Math.round(((accepted + failed) / t.total) * 10) / 10 : 0,
      statusDistribution: CONTACT_INTEL_STATUSES.map((name) => ({ name, value: byStatus[name] })).filter((s) => s.value > 0),
      emailsOverTime: emailsByDay.map((d) => ({ date: d._id, accepted: d.accepted, failed: d.failed })),
      incomingOverTime: incomingByDay.map((d) => ({ date: d._id, bounces: d.bounces, replies: d.replies, autoReplies: d.autoReplies })),
      bounceStats: [
        { name: "Hard bounce", value: incomingCounts.hard_bounce ?? 0 },
        { name: "Soft bounce", value: incomingCounts.soft_bounce ?? 0 },
        { name: "Temporarily rejected", value: incomingCounts.temporary_rejection ?? 0 },
        { name: "Rejected", value: incomingCounts.rejected ?? 0 },
      ],
      replyStats: [
        { name: "Replies", value: incomingCounts.human_reply ?? 0 },
        { name: "Auto replies", value: incomingCounts.auto_reply ?? 0 },
        { name: "Out of office", value: incomingCounts.out_of_office ?? 0 },
      ],
      filters: {
        categories: categories.filter(Boolean).sort(),
        companies: companies.filter(Boolean).sort(),
      },
    },
  });
}
