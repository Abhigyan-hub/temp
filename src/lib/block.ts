import { formatDateTime } from "./datetime";
import type { Contact } from "./store";

export const QUICK_BLOCK_REASONS = ["Asked not to be contacted", "Not hiring right now", "Already applied", "Email bounced", "Follow up later"];

export const BLOCK_DURATIONS = {
  "1w": { label: "1 week", days: 7 },
  "1m": { label: "1 month", days: 30 },
  "3m": { label: "3 months", days: 90 },
  "6m": { label: "6 months", days: 182 },
  custom: { label: "Until a date…", days: 0 },
  forever: { label: "Until I unblock", days: 0 },
} as const;
export type BlockDuration = keyof typeof BLOCK_DURATIONS;

export interface BlockValue {
  reason: string;
  duration: BlockDuration;
  customUntil: string; // yyyy-MM-ddTHH:mm (local)
}

const pad = (n: number) => String(n).padStart(2, "0");
const toLocalInput = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** Starting values: the contact's current block, or "1 month" for a new one. */
export function initialBlockValue(contact?: Pick<Contact, "blocked" | "blockReason" | "blockedUntil"> | null): BlockValue {
  if (contact?.blocked) {
    return {
      reason: contact.blockReason ?? "",
      duration: contact.blockedUntil ? "custom" : "forever",
      customUntil: contact.blockedUntil ? toLocalInput(new Date(contact.blockedUntil)) : toLocalInput(new Date(Date.now() + 30 * 86400e3)),
    };
  }
  return { reason: "", duration: "1m", customUntil: toLocalInput(new Date(Date.now() + 30 * 86400e3)) };
}

/** ISO end date for the chosen duration (null = until unblocked), or an error message. */
export function blockUntilFrom(value: BlockValue): { until: string | null } | { error: string } {
  if (value.duration === "forever") return { until: null };
  if (value.duration === "custom") {
    const d = new Date(value.customUntil);
    if (Number.isNaN(d.getTime())) return { error: "Pick the date the block ends" };
    if (d.getTime() <= Date.now()) return { error: "The block end must be in the future" };
    return { until: d.toISOString() };
  }
  return { until: new Date(Date.now() + BLOCK_DURATIONS[value.duration].days * 86400e3).toISOString() };
}

/** "Until 10 November 2026, 9:00 AM" / "Until you unblock". */
export const blockUntilLabel = (c: Pick<Contact, "blockedUntil">, timezone?: string) =>
  c.blockedUntil ? `Until ${formatDateTime(c.blockedUntil, timezone)}` : "Until you unblock";
