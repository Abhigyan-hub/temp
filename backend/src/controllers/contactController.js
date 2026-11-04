import { z } from "zod";
import { Contact, CONTACT_STATUSES } from "../models/Contact.js";
import { ScheduledEmail } from "../models/ScheduledEmail.js";
import { User } from "../models/User.js";
import { AppError, notFound } from "../utils/AppError.js";
import { CLEARED_BLOCK, describeBlock, releaseExpiredBlocks } from "../services/blockService.js";
import { applyEmailChange, INTEL_VERSION, logActivity } from "../services/contactIntel.js";
import { saveNotesFromForm } from "../services/noteService.js";
import { normalizeImportRow, resolveCompany } from "../shared/contactData.js";
import { emailField, escapeRegex, isValidEmail, optionalText } from "../utils/validators.js";

const MAX_IMPORT = 5000;

const contactFields = {
  name: optionalText(150),
  title: optionalText(150),
  company: optionalText(150),
  category: z
    .string()
    .trim()
    .max(80)
    .optional()
    .transform((v) => v || "Uncategorized"),
  notes: z.string().max(5000).optional().default(""),
};

export const schemas = {
  list: z.object({
    search: z.string().trim().max(100).optional(),
    category: z.string().trim().max(80).optional(),
    status: z.enum([...CONTACT_STATUSES, "Blocked"]).optional(),
  }),
  create: z.object({ ...contactFields, email: emailField }),
  update: z
    .object({
      name: z.string().trim().max(150),
      title: z.string().trim().max(150),
      company: z.string().trim().max(150),
      category: z
        .string()
        .trim()
        .max(80)
        .transform((v) => v || "Uncategorized"),
      notes: z.string().max(5000),
      email: emailField,
    })
    .partial(),
  block: z.object({
    blocked: z.boolean().optional(),
    reason: z.string().trim().max(500).optional().default(""),
    // ISO date-time to block until; null / omitted = until manually unblocked.
    until: z
      .string()
      .datetime({ offset: true, message: "Block end must be an ISO date-time" })
      .transform((s) => new Date(s))
      .refine((d) => d.getTime() > Date.now(), "Block end must be in the future")
      .nullable()
      .optional(),
  }),
  import: z.object({
    contacts: z
      .array(z.record(z.string(), z.unknown()))
      .min(1, "No rows to import")
      .max(MAX_IMPORT, `Import at most ${MAX_IMPORT} contacts at a time`),
  }),
};

/** Reserve `count` serial numbers for a user atomically. Returns the first one. */
async function reserveSerials(userId, count) {
  const user = await User.findByIdAndUpdate(userId, { $inc: { contactSeq: count } }, { returnDocument: "after" }).select(
    "+contactSeq",
  );
  return user.contactSeq - count + 1;
}

const cancelPendingFor = (userId, filter, reason) =>
  ScheduledEmail.updateMany(
    { userId, status: "Pending", ...filter },
    { status: "Cancelled", errorMessage: reason, processedAt: new Date() },
  );

export async function list(req, res) {
  const { search, category, status } = req.validatedQuery;
  await releaseExpiredBlocks({ userId: req.user._id });
  const filter = { userId: req.user._id };
  if (category) filter.category = category;
  if (status === "Blocked") filter.isBlocked = true;
  else if (status) Object.assign(filter, { emailStatus: status, isBlocked: false });
  if (search) {
    const re = new RegExp(escapeRegex(search), "i");
    filter.$or = [{ name: re }, { email: re }, { company: re }, { title: re }];
  }

  const [contacts, categories] = await Promise.all([
    Contact.find(filter).sort({ serialNo: 1 }).limit(10000),
    Contact.distinct("category", { userId: req.user._id }),
  ]);
  res.json({ success: true, contacts, categories: categories.sort() });
}

export async function create(req, res) {
  const { email, company, notes } = req.body;
  if (await Contact.exists({ userId: req.user._id, email })) {
    throw new AppError(409, "A contact with this email already exists");
  }
  const serialNo = await reserveSerials(req.user._id, 1);
  const contact = await Contact.create({
    ...req.body,
    company: resolveCompany(company, email),
    noteUpdatedAt: notes.trim() ? new Date() : null,
    userId: req.user._id,
    serialNo,
    intelVersion: INTEL_VERSION,
    lastActivityAt: new Date(),
  });
  await logActivity({ userId: req.user._id, contactId: contact._id, type: "contact_created", description: "Contact created" });
  res.status(201).json({ success: true, contact });
}

export async function update(req, res) {
  const { id } = req.params;
  const contact = await Contact.findOne({ _id: id, userId: req.user._id });
  if (!contact) throw notFound("Contact");

  const patch = req.body;
  if (
    patch.email &&
    patch.email !== contact.email &&
    (await Contact.exists({ userId: req.user._id, email: patch.email, _id: { $ne: id } }))
  ) {
    throw new AppError(409, "Another contact already uses this email");
  }

  for (const field of ["name", "title", "company", "category"]) {
    if (patch[field] !== undefined) contact[field] = patch[field];
  }
  const oldEmail = contact.email;
  const emailChanged = !!patch.email && patch.email !== oldEmail;
  if (emailChanged) applyEmailChange(contact, patch.email);
  // A cleared company is filled back in from the (possibly new) email domain.
  contact.company = resolveCompany(contact.company, contact.email);

  if (patch.notes !== undefined && patch.notes !== contact.notes) await saveNotesFromForm(contact, patch.notes);

  // Same document, same _id: email history and schedules keep pointing at this contact.
  await contact.save();
  if (emailChanged) {
    await logActivity({ userId: req.user._id, contactId: contact._id, type: "email_changed", description: `Email address changed from ${oldEmail} to ${contact.email}`, metadata: { from: oldEmail, to: contact.email } });
  }
  res.json({ success: true, contact });
}

export async function remove(req, res) {
  const contact = await Contact.findOneAndDelete({ _id: req.params.id, userId: req.user._id });
  if (!contact) throw notFound("Contact");
  await cancelPendingFor(req.user._id, { contactId: contact._id }, "Contact deleted");
  res.json({ success: true });
}

export async function toggleBlock(req, res) {
  const userId = req.user._id;
  await releaseExpiredBlocks({ userId, _id: req.params.id });
  const contact = await Contact.findOne({ _id: req.params.id, userId });
  if (!contact) throw notFound("Contact");

  const block = req.body.blocked ?? !contact.isBlocked;
  if (!block) {
    const wasBlocked = contact.isBlocked;
    contact.set(CLEARED_BLOCK);
    contact.lastActivityAt = new Date();
    await contact.save();
    if (wasBlocked) await logActivity({ userId, contactId: contact._id, type: "unblocked", description: "Contact unblocked" });
    return res.json({ success: true, contact });
  }

  // Blocking again just updates the reason / end date.
  contact.set({
    isBlocked: true,
    blockReason: req.body.reason,
    blockedAt: contact.isBlocked && contact.blockedAt ? contact.blockedAt : new Date(),
    blockedUntil: req.body.until ?? null,
    lastActivityAt: new Date(),
  });
  await contact.save();
  await logActivity({ userId, contactId: contact._id, type: "blocked", description: describeBlock(contact, req.user.settings?.timezone) });

  // Cancel only what would go out while the block lasts; later schedules stay.
  const window = contact.blockedUntil ? { scheduledAt: { $lt: contact.blockedUntil } } : {};
  await cancelPendingFor(userId, { contactId: contact._id, ...window }, describeBlock(contact, req.user.settings?.timezone));
  res.json({ success: true, contact });
}

export async function importContacts(req, res) {
  const userId = req.user._id;
  // Header matching (Email ID, Full Name, Designation…) is shared with the web app's import preview.
  const rows = req.body.contacts.map((raw) => {
    const r = normalizeImportRow(raw);
    return { ...r, category: r.category || "Uncategorized" };
  });

  const errors = [];
  const seen = new Set();
  const candidates = [];
  let invalid = 0;
  let duplicates = 0;
  let missingOptional = 0;
  let companyFromEmail = 0;

  rows.forEach((r, i) => {
    if (!isValidEmail(r.email)) {
      invalid++;
      // Row numbers are 1-based and skip the header row, matching what the user sees in their sheet.
      if (errors.length < 20) {
        errors.push({ row: i + 2, message: r.email ? `Invalid email "${r.email}"` : "Missing email" });
      }
      return;
    }
    if (seen.has(r.email)) {
      duplicates++;
      return;
    }
    seen.add(r.email);
    candidates.push(r);
  });

  const existing = new Set(
    (await Contact.find({ userId, email: { $in: candidates.map((c) => c.email) } }).select("email")).map(
      (c) => c.email,
    ),
  );
  const toInsert = candidates.filter((c) => !existing.has(c.email));
  duplicates += candidates.length - toInsert.length;

  const now = new Date();
  const docs = toInsert.map((c) => {
    if (!c.name || !c.title || !c.company) missingOptional++;
    const company = resolveCompany(c.company, c.email);
    if (!c.company && company) companyFromEmail++;
    return { ...c, company, noteUpdatedAt: c.notes ? now : null, userId, intelVersion: INTEL_VERSION, lastActivityAt: now };
  });

  let imported = 0;
  if (docs.length) {
    const start = await reserveSerials(userId, docs.length);
    try {
      const inserted = await Contact.insertMany(
        docs.map((d, i) => ({ ...d, serialNo: start + i })),
        { ordered: false },
      );
      imported = inserted.length;
    } catch (err) {
      // A concurrent import may have inserted some of the same emails; count those as duplicates.
      if (err?.code !== 11000 && !err?.writeErrors) throw err;
      imported = err.insertedDocs?.length ?? err.result?.insertedCount ?? 0;
      duplicates += toInsert.length - imported;
    }
  }

  res.status(imported ? 201 : 200).json({
    success: true,
    total: rows.length,
    imported,
    duplicates,
    invalid,
    // Among the new contacts: rows without a name, title or company, and companies filled in from the email.
    missingOptional,
    companyFromEmail,
    errors,
  });
}
