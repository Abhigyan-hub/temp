import { Contact } from "../models/Contact.js";
import { ContactActivity } from "../models/ContactActivity.js";
import { EmailHistory } from "../models/EmailHistory.js";

/** Contacts created before these fields existed are brought up to this version once. */
export const INTEL_VERSION = 1;

const SOFT_BOUNCE_RETRY_MS = 24 * 60 * 60 * 1000;
const TEMP_REJECT_RETRY_MS = 60 * 60 * 1000;

export function logActivity({ userId, contactId, type, description, metadata = {}, relatedEmailId, at }) {
  return ContactActivity.create({
    userId,
    contactId,
    activityType: type,
    description: String(description).slice(0, 1000),
    metadata,
    relatedEmailId,
    occurredAt: at ?? new Date(),
  });
}

function emailMetadata(history) {
  return {
    subject: history.subject,
    template: history.templateName,
    attachments: (history.attachments ?? []).map((a) => a.fileName),
    status: history.status,
    source: history.source,
    recipient: history.recipient,
    senderEmail: history.senderEmail,
    campaignId: history.campaignId ? String(history.campaignId) : undefined,
    error: history.errorMessage || undefined,
  };
}

/**
 * Apply one SMTP attempt to the contact's counters and status, and write the timeline entry.
 * Only failures that say something about the *address* change its status: a login or network
 * problem on our side, or a temporary refusal, never marks a contact bad.
 */
export async function recordSendAttempt({ contactId, userId, history, failureKind }) {
  const contact = await Contact.findOne({ _id: contactId, userId });
  if (!contact) return null;
  const now = history.sentAt ?? new Date();
  const accepted = history.status === "Sent";

  contact.emailStatus = accepted ? "Sent" : "Failed";
  contact.lastEmailedAt = now;
  contact.lastActivityAt = now;

  if (history.dryRun) {
    // Nothing reached a mail server, so counters and deliverability stay untouched.
    contact.lastEmailStatus = "Dry run (not delivered)";
    await contact.save();
    return contact;
  }

  contact.totalEmailsSent += 1;
  if (accepted) {
    contact.acceptedCount += 1;
    contact.deliveryStatus = "Accepted";
    contact.lastEmailStatus = "Accepted";
    if (contact.bounceStatus === "Temporary") contact.bounceStatus = "None";
  } else {
    contact.failedCount += 1;
    contact.deliveryStatus = "Failed";
    contact.lastEmailStatus = "Failed";
    if (failureKind === "hard") {
      contact.bounceStatus = "Hard";
      contact.emailValidity = "Invalid";
      contact.hardBounceCount += 1;
      contact.lastBounceAt = now;
      contact.bounceReason = history.errorMessage.slice(0, 500);
    } else if (failureKind === "temporary") {
      contact.bounceStatus = "Temporary";
      contact.bounceReason = history.errorMessage.slice(0, 500);
    } else if (failureKind === "rejected") {
      contact.bounceStatus = "Rejected";
      contact.lastBounceAt = now;
      contact.bounceReason = history.errorMessage.slice(0, 500);
    }
  }
  await contact.save();

  await logActivity({
    userId,
    contactId,
    type: accepted ? "email_sent" : "email_failed",
    description: accepted
      ? `Email accepted by the mail server: ${history.subject}`
      : `Sending failed: ${history.errorMessage || "unknown error"}`,
    metadata: emailMetadata(history),
    relatedEmailId: history._id,
    at: now,
  });
  if (failureKind === "hard") {
    await logActivity({ userId, contactId, type: "marked_invalid", description: "Email address marked invalid (the server rejected it permanently)", relatedEmailId: history._id, at: now });
  }
  return contact;
}

const INCOMING_DESCRIPTIONS = {
  hard_bounce: "Delivery failure received: the address doesn't exist or can't receive mail",
  soft_bounce: "Temporary delivery failure received",
  temporary_rejection: "Recipient server temporarily refused the email",
  rejected: "Recipient server rejected the email",
  complaint: "Spam complaint received",
  auto_reply: "Automatic reply received",
  out_of_office: "Out-of-office reply received",
  human_reply: "Reply received",
};

/**
 * Apply a reply or bounce notification to the contact. A bounce for an address the contact has
 * since been corrected away from is recorded on the timeline but doesn't affect the new address.
 */
export async function recordIncoming({ contact, incoming, history, at = new Date() }) {
  const c = incoming.classification;
  const bouncedAddress = (incoming.bounce?.finalRecipient || history?.recipient || "").toLowerCase();
  const isBounce = ["hard_bounce", "soft_bounce", "temporary_rejection", "rejected"].includes(c);
  const stale = isBounce && bouncedAddress && bouncedAddress !== contact.email;
  const reason = (incoming.bounce?.diagnostic || incoming.bounce?.status || "").slice(0, 500);

  contact.lastActivityAt = at;
  contact.lastEmailReceivedAt = at;

  if (!stale) {
    switch (c) {
      case "hard_bounce":
        contact.bounceStatus = "Hard";
        contact.emailValidity = "Invalid";
        contact.deliveryStatus = "Bounced";
        contact.lastEmailStatus = "Hard bounced";
        contact.hardBounceCount += 1;
        contact.lastBounceAt = at;
        contact.bounceReason = reason;
        break;
      case "soft_bounce":
        contact.bounceStatus = "Soft";
        contact.deliveryStatus = "Bounced";
        contact.lastEmailStatus = "Soft bounced";
        contact.softBounceCount += 1;
        contact.softBounceTotal += 1;
        contact.softBounceRetryAt = new Date(at.getTime() + SOFT_BOUNCE_RETRY_MS);
        contact.lastBounceAt = at;
        contact.bounceReason = reason;
        break;
      case "temporary_rejection":
        contact.bounceStatus = "Temporary";
        contact.deliveryStatus = "Bounced";
        contact.lastEmailStatus = "Temporarily rejected";
        contact.softBounceRetryAt = new Date(at.getTime() + TEMP_REJECT_RETRY_MS);
        contact.bounceReason = reason;
        break;
      case "rejected":
        contact.bounceStatus = "Rejected";
        contact.deliveryStatus = "Bounced";
        contact.lastEmailStatus = "Rejected";
        contact.lastBounceAt = at;
        contact.bounceReason = reason;
        break;
      case "complaint":
        contact.unsubscribed = true;
        contact.lastEmailStatus = "Spam complaint";
        break;
      case "human_reply":
        contact.replyStatus = "Replied";
        contact.replyCount += 1;
        contact.lastRepliedAt = at;
        contact.emailValidity = "Valid";
        contact.bounceStatus = "None";
        contact.softBounceCount = 0;
        contact.softBounceRetryAt = null;
        contact.lastEmailStatus = "Replied";
        break;
      case "auto_reply":
      case "out_of_office":
        // Proves the mailbox exists. Not a bounce, and not a real reply.
        if (contact.replyStatus !== "Replied") contact.replyStatus = "Auto Replied";
        if (contact.emailValidity === "Unknown") contact.emailValidity = "Valid";
        contact.lastEmailStatus = "Auto replied";
        break;
    }
  }
  await contact.save();

  await logActivity({
    userId: contact.userId,
    contactId: contact._id,
    type: c,
    description: stale
      ? `${INCOMING_DESCRIPTIONS[c]} (for the old address ${bouncedAddress})`
      : INCOMING_DESCRIPTIONS[c],
    metadata: {
      subject: incoming.subject,
      from: incoming.senderEmail,
      status: incoming.bounce?.status,
      diagnostic: incoming.bounce?.diagnostic,
      matchedBy: incoming.matchedBy,
    },
    relatedEmailId: history?._id,
    at,
  });
  if (c === "hard_bounce" && !stale) {
    await logActivity({ userId: contact.userId, contactId: contact._id, type: "marked_invalid", description: "Email address marked invalid", relatedEmailId: history?._id, at });
  }
}

/**
 * Change a contact's address, keeping the old one in addressHistory. Deliverability state
 * belonged to the old address, so it starts over; reply and send counts stay as history.
 */
export function applyEmailChange(contact, newEmail, reason = "Corrected by user") {
  contact.addressHistory.push({ email: contact.email, status: contact.contactStatus, reason, changedAt: new Date() });
  contact.email = newEmail;
  contact.emailValidity = "Unknown";
  contact.deliveryStatus = "None";
  contact.bounceStatus = "None";
  contact.bounceReason = "";
  contact.replyStatus = "None";
  contact.softBounceCount = 0;
  contact.softBounceRetryAt = null;
  contact.lastActivityAt = new Date();
}

/** Field changes behind a manual status correction. */
export const MANUAL_STATUS_PATCHES = {
  Unknown: { emailValidity: "Unknown", bounceStatus: "None", replyStatus: "None", unsubscribed: false, softBounceCount: 0, softBounceRetryAt: null, bounceReason: "" },
  Valid: { emailValidity: "Valid", bounceStatus: "None", unsubscribed: false, softBounceCount: 0, softBounceRetryAt: null, bounceReason: "" },
  Invalid: { emailValidity: "Invalid" },
  "Hard Bounced": { bounceStatus: "Hard", emailValidity: "Invalid" },
  "Soft Bounced": { bounceStatus: "Soft", emailValidity: "Unknown", replyStatus: "None" },
  "Temporarily Rejected": { bounceStatus: "Temporary", emailValidity: "Unknown", replyStatus: "None" },
  Bounced: { bounceStatus: "Rejected", emailValidity: "Unknown", replyStatus: "None" },
  Replied: { replyStatus: "Replied", emailValidity: "Valid", bounceStatus: "None", softBounceCount: 0, softBounceRetryAt: null },
  "Auto Replied": { replyStatus: "Auto Replied", bounceStatus: "None" },
  Unsubscribed: { unsubscribed: true },
};

/** Bring one user's older contacts up to date from EmailHistory. Safe to run repeatedly. */
async function backfillContact(contact) {
  const rows = await EmailHistory.find({ userId: contact.userId, contactId: contact._id, source: { $ne: "test" }, dryRun: { $ne: true } })
    .sort({ sentAt: 1 })
    .select("-body");
  for (const h of rows) {
    contact.totalEmailsSent += 1;
    if (h.status === "Sent") contact.acceptedCount += 1;
    else contact.failedCount += 1;
    contact.lastEmailStatus = h.status === "Sent" ? "Accepted" : "Failed";
    contact.deliveryStatus = h.status === "Sent" ? "Accepted" : "Failed";
    contact.lastActivityAt = h.sentAt;
  }
  contact.lastActivityAt ??= contact.createdAt;
  contact.intelVersion = INTEL_VERSION;
  await contact.save({ timestamps: false });

  const seen = new Set(
    (await ContactActivity.find({ userId: contact.userId, contactId: contact._id, relatedEmailId: { $ne: null } }).select("relatedEmailId")).map((a) => String(a.relatedEmailId)),
  );
  const missing = rows.filter((h) => !seen.has(String(h._id)));
  if (missing.length) {
    await ContactActivity.insertMany(
      missing.map((h) => ({
        userId: contact.userId,
        contactId: contact._id,
        activityType: h.status === "Sent" ? "email_sent" : "email_failed",
        description: h.status === "Sent" ? `Email accepted by the mail server: ${h.subject}` : `Sending failed: ${h.errorMessage || "unknown error"}`,
        metadata: emailMetadata(h),
        relatedEmailId: h._id,
        occurredAt: h.sentAt,
      })),
    );
  }
}

export async function backfillContactIntel({ batch = 200 } = {}) {
  let total = 0;
  for (;;) {
    const contacts = await Contact.find({ intelVersion: { $lt: INTEL_VERSION } }).limit(batch);
    if (contacts.length === 0) break;
    for (const contact of contacts) await backfillContact(contact);
    total += contacts.length;
  }
  if (total) console.log(`🗂️  Updated ${total} existing contacts with email statistics`);
  return total;
}
