import crypto from "node:crypto";
import { z } from "zod";
import { env } from "../config/env.js";
import { Contact } from "../models/Contact.js";
import { Resume } from "../models/Resume.js";
import { attachmentMeta, resolveResumes, verifyStored } from "../services/attachmentService.js";
import { releaseExpiredBlocks, restrictionFor } from "../services/blockService.js";
import { resolveSender } from "../services/senderService.js";
import { ScheduledEmail, SCHEDULE_STATUSES } from "../models/ScheduledEmail.js";
import { Template } from "../models/Template.js";
import { sendScheduleNow } from "../services/schedulerService.js";
import { AppError, notFound } from "../utils/AppError.js";
import { objectId } from "../utils/validators.js";

const MAX_AHEAD_MS = 366 * 24 * 60 * 60 * 1000;
const GRACE_MS = 2 * 60 * 1000;

const scheduledAt = z
  .string({ error: "Scheduled time is required" })
  .datetime({ offset: true, message: "Scheduled time must be an ISO date-time" })
  .transform((s) => new Date(s))
  .refine((d) => d.getTime() >= Date.now() - GRACE_MS, "Scheduled time is in the past")
  .refine((d) => d.getTime() <= Date.now() + MAX_AHEAD_MS, "Schedule at most one year ahead");

export const schemas = {
  create: z.object({
    templateId: objectId,
    contactIds: z.array(objectId).min(1, "Select at least one contact").max(1000),
    scheduledAt,
    timezone: z.string().trim().max(64).optional().default("UTC"),
    comments: z.string().trim().max(1000).optional().default(""),
    resumeIds: z.array(objectId).max(env.ATTACHMENT_MAX_COUNT, `Attach at most ${env.ATTACHMENT_MAX_COUNT} resumes`).optional().default([]),
    emailAccountId: z.string().max(40).optional(),
  }),
  update: z.object({ scheduledAt: scheduledAt.optional(), comments: z.string().trim().max(1000).optional() }),
  list: z.object({ status: z.enum(SCHEDULE_STATUSES).optional() }),
};

async function shape(userId, schedules) {
  const contactIds = [...new Set(schedules.map((s) => String(s.contactId)))];
  const templateIds = [...new Set(schedules.map((s) => String(s.templateId)))];
  const resumeIds = [...new Set(schedules.flatMap((s) => (s.resumeIds ?? []).map(String)))];
  const [contacts, templates, resumes] = await Promise.all([
    Contact.find({ userId, _id: { $in: contactIds } }).select("name email company"),
    Template.find({ userId, _id: { $in: templateIds } }).select("name"),
    resumeIds.length ? Resume.find({ userId, _id: { $in: resumeIds } }) : [],
  ]);
  const cMap = new Map(contacts.map((c) => [String(c._id), c]));
  const tMap = new Map(templates.map((t) => [String(t._id), t]));
  const rMap = new Map(resumes.map((r) => [String(r._id), r]));
  return schedules.map((s) => {
    const json = s.toJSON();
    const c = cMap.get(String(s.contactId));
    const t = tMap.get(String(s.templateId));
    return {
      ...json,
      contactId: String(s.contactId),
      templateId: String(s.templateId),
      resumeIds: (s.resumeIds ?? []).map(String),
      contact: c ? { id: String(c._id), name: c.name, email: c.email, company: c.company } : null,
      template: t ? { id: String(t._id), name: t.name } : null,
      // A deleted resume shows as missing so the user can see why a schedule would fail.
      attachments: (s.resumeIds ?? []).map((id) => {
        const r = rMap.get(String(id));
        return r ? { ...attachmentMeta(r), resumeId: String(id), missing: false } : { resumeId: String(id), fileName: "Deleted resume", missing: true };
      }),
    };
  });
}

/** After cancelling, contacts with no remaining pending schedule go back from Scheduled to Pending. */
async function releaseScheduledContacts(userId, contactIds) {
  for (const contactId of contactIds) {
    const stillPending = await ScheduledEmail.exists({ userId, contactId, status: { $in: ["Pending", "Processing"] } });
    if (!stillPending) await Contact.updateOne({ _id: contactId, userId, emailStatus: "Scheduled" }, { emailStatus: "Pending" });
  }
}

export async function create(req, res) {
  const userId = req.user._id;
  const { templateId, contactIds, scheduledAt, timezone, comments } = req.body;

  const template = await Template.findOne({ _id: templateId, userId });
  if (!template) throw notFound("Template");

  await releaseExpiredBlocks({ userId, _id: { $in: contactIds } });
  const found = await Contact.find({ _id: { $in: [...new Set(contactIds)] }, userId });
  // A block that ends before the send time doesn't stop the schedule.
  const timezone_ = req.user.settings?.timezone;
  const contacts = found.filter((c) => !restrictionFor(c, timezone_, scheduledAt));
  const blocked = found
    .filter((c) => restrictionFor(c, timezone_, scheduledAt))
    .map((c) => {
      const r = restrictionFor(c, timezone_, scheduledAt);
      return {
        contactId: String(c._id),
        name: c.name,
        email: c.email,
        reason: r.code === "blocked" ? c.blockReason : r.message,
        until: c.blockedUntil,
        message: r.message,
      };
    });
  if (!contacts.length) {
    throw new AppError(400, blocked.length ? `Not scheduled. ${blocked[0].message}` : "None of the selected contacts can be scheduled");
  }

  // Ownership, limits and presence in storage are checked now; the files are fetched when the job runs.
  const resumes = await resolveResumes(userId, req.body.resumeIds);
  await verifyStored(resumes);
  const resumeIds = resumes.map((r) => r._id);

  // A chosen account is pinned to the schedule. With no choice the sending mode decides at run time.
  const sender = req.body.emailAccountId ? await resolveSender(req.user, req.body.emailAccountId) : { accountId: null };

  const batchId = crypto.randomUUID();
  let created = [];
  try {
    created = await ScheduledEmail.insertMany(
      contacts.map((c) => ({
        userId,
        contactId: c._id,
        templateId,
        scheduledAt,
        timezone,
        comments,
        batchId,
        resumeIds,
        emailAccountId: sender.accountId,
        usesSystem: req.body.emailAccountId === "system",
      })),
      { ordered: false },
    );
  } catch (err) {
    if (err?.code !== 11000 && !err?.writeErrors) throw err;
    created = err.insertedDocs ?? [];
  }

  await Contact.updateMany(
    { userId, _id: { $in: created.map((s) => s.contactId) }, emailStatus: "Pending" },
    { emailStatus: "Scheduled" },
  );

  res.status(201).json({
    success: true,
    scheduled: created.length,
    skipped: contactIds.length - created.length,
    blocked,
    schedules: await shape(userId, created),
  });
}

export async function list(req, res) {
  const filter = { userId: req.user._id };
  if (req.validatedQuery.status) filter.status = req.validatedQuery.status;
  const schedules = await ScheduledEmail.find(filter).sort({ scheduledAt: 1 }).limit(2000);
  res.json({ success: true, schedules: await shape(req.user._id, schedules) });
}

export async function update(req, res) {
  const patch = {};
  if (req.body.scheduledAt) patch.scheduledAt = req.body.scheduledAt;
  if (req.body.comments !== undefined) patch.comments = req.body.comments;
  const schedule = await ScheduledEmail.findOneAndUpdate(
    { _id: req.params.id, userId: req.user._id, status: "Pending" },
    { $set: { ...patch, errorMessage: "" } },
    { returnDocument: "after" },
  );
  if (!schedule) throw new AppError(409, "Only pending schedules can be changed");
  res.json({ success: true, schedule: (await shape(req.user._id, [schedule]))[0] });
}

export async function cancel(req, res) {
  const schedule = await ScheduledEmail.findOneAndUpdate(
    { _id: req.params.id, userId: req.user._id, status: "Pending" },
    { $set: { status: "Cancelled", processedAt: new Date(), errorMessage: "Cancelled by user" } },
    { returnDocument: "after" },
  );
  if (!schedule) throw new AppError(409, "Only pending schedules can be cancelled");
  await releaseScheduledContacts(req.user._id, [schedule.contactId]);
  res.json({ success: true, schedule: (await shape(req.user._id, [schedule]))[0] });
}

export async function sendNow(req, res) {
  const schedule = await sendScheduleNow(req.params.id, req.user._id);
  if (!schedule) throw new AppError(409, "Only pending schedules can be sent now");
  res.json({ success: true, schedule: (await shape(req.user._id, [schedule]))[0] });
}

export async function remove(req, res) {
  const schedule = await ScheduledEmail.findOneAndDelete({
    _id: req.params.id,
    userId: req.user._id,
    status: { $ne: "Processing" },
  });
  if (!schedule) throw new AppError(409, "Schedule not found or currently sending");
  await releaseScheduledContacts(req.user._id, [schedule.contactId]);
  res.json({ success: true });
}
