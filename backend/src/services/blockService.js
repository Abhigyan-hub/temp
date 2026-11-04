import { Contact } from "../models/Contact.js";
import { ContactActivity } from "../models/ContactActivity.js";
import { sendRestriction } from "../shared/contactStatus.js";
import { formatDateTime } from "../shared/datetime.js";

/** Whether a block applies at `at` (default now). Blocks with an end date lapse on their own. */
export const isBlockedAt = (contact, at = new Date()) =>
  !!contact?.isBlocked && (!contact.blockedUntil || new Date(contact.blockedUntil) > at);

/** "Blocked until 10 November 2026, 9:00 AM: Asked not to be contacted" / "Blocked until you unblock: …" */
export function describeBlock(contact, timeZone) {
  const until = contact.blockedUntil ? `until ${formatDateTime(contact.blockedUntil, timeZone)}` : "until you unblock";
  const reason = contact.blockReason?.trim();
  return `Blocked ${until}${reason ? `: ${reason}` : ""}`;
}

/** The reason this contact can't be emailed at `at`, worded for the user, or null. */
export function restrictionFor(contact, timeZone, at = new Date()) {
  const r = sendRestriction(contact, at);
  if (!r) return null;
  if (r.code === "blocked") return { ...r, message: describeBlock(contact, timeZone) };
  if (r.code === "soft_cooldown") return { ...r, message: `Recently soft bounced: retry after ${formatDateTime(r.retryAt, timeZone)}` };
  return r;
}

export const CLEARED_BLOCK = { isBlocked: false, blockReason: "", blockedAt: null, blockedUntil: null };

/** Lift blocks whose end date has passed. Cheap (indexed); called before anything that reads block state. */
export async function releaseExpiredBlocks(filter = {}) {
  const expired = await Contact.find({ ...filter, isBlocked: true, blockedUntil: { $ne: null, $lte: new Date() } });
  for (const contact of expired) {
    contact.set(CLEARED_BLOCK);
    await contact.save(); // recomputes contactStatus
    await ContactActivity.create({
      userId: contact.userId,
      contactId: contact._id,
      activityType: "unblocked",
      description: "Block ended automatically",
    });
  }
  return { released: expired.length };
}
