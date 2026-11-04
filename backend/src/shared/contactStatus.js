// Contact deliverability rules, shared by the API and the web app so Compose disables exactly
// what the server refuses. Types: contactStatus.d.ts.

export const CONTACT_INTEL_STATUSES = [
  "Valid",
  "Unknown",
  "Invalid",
  "Bounced",
  "Soft Bounced",
  "Hard Bounced",
  "Temporarily Rejected",
  "Blocked",
  "Replied",
  "Auto Replied",
  "Unsubscribed",
];

/** Soft bounces in a row (without a reply) after which a contact needs a manual decision. */
export const SOFT_BOUNCE_LIMIT = 3;

const blockActive = (c, at) => !!c?.isBlocked && (!c.blockedUntil || new Date(c.blockedUntil) > at);

/** The single status shown for a contact. Most restrictive first; SMTP acceptance never proves validity. */
export function computeContactStatus(c, at = new Date()) {
  if (blockActive(c, at)) return "Blocked";
  if (c?.unsubscribed) return "Unsubscribed";
  if (c?.bounceStatus === "Hard") return "Hard Bounced";
  if (c?.emailValidity === "Invalid") return "Invalid";
  if (c?.replyStatus === "Replied") return "Replied";
  if (c?.bounceStatus === "Soft") return "Soft Bounced";
  if (c?.bounceStatus === "Temporary") return "Temporarily Rejected";
  if (c?.bounceStatus === "Rejected") return "Bounced";
  if (c?.replyStatus === "Auto Replied") return "Auto Replied";
  if (c?.emailValidity === "Valid") return "Valid";
  return "Unknown";
}

/**
 * Why this contact must not be emailed at `at`, or null if it may be.
 * code: blocked | unsubscribed | hard_bounce | invalid | soft_limit | soft_cooldown
 * `selectable` is false for anything that needs a deliberate status change first.
 */
export function sendRestriction(c, at = new Date()) {
  if (blockActive(c, at)) return { code: "blocked", selectable: false, message: "Blocked" };
  if (c?.unsubscribed) return { code: "unsubscribed", selectable: false, message: "Unsubscribed: this contact opted out of email" };
  if (c?.bounceStatus === "Hard") {
    return { code: "hard_bounce", selectable: false, message: "Hard bounced: correct the address or change the status before sending" };
  }
  if (c?.emailValidity === "Invalid") {
    return { code: "invalid", selectable: false, message: "Marked invalid: correct the address or change the status before sending" };
  }
  if ((c?.softBounceCount ?? 0) >= SOFT_BOUNCE_LIMIT) {
    return { code: "soft_limit", selectable: false, message: `${SOFT_BOUNCE_LIMIT} soft bounces in a row: review this contact before sending again` };
  }
  if (c?.softBounceRetryAt && new Date(c.softBounceRetryAt) > at) {
    return {
      code: "soft_cooldown",
      selectable: false,
      retryAt: c.softBounceRetryAt,
      message: "Recently soft bounced: waiting before retrying this address",
    };
  }
  return null;
}
