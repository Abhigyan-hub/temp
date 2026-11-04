export type ContactIntelStatus =
  | "Valid"
  | "Unknown"
  | "Invalid"
  | "Bounced"
  | "Soft Bounced"
  | "Hard Bounced"
  | "Temporarily Rejected"
  | "Blocked"
  | "Replied"
  | "Auto Replied"
  | "Unsubscribed";

export const CONTACT_INTEL_STATUSES: ContactIntelStatus[];
export const SOFT_BOUNCE_LIMIT: number;

export interface SendRestriction {
  code: "blocked" | "unsubscribed" | "hard_bounce" | "invalid" | "soft_limit" | "soft_cooldown";
  selectable: boolean;
  message: string;
  retryAt?: string | Date;
}

interface StatusInput {
  isBlocked?: boolean;
  blockedUntil?: string | Date | null;
  unsubscribed?: boolean;
  bounceStatus?: string;
  emailValidity?: string;
  replyStatus?: string;
  softBounceCount?: number;
  softBounceRetryAt?: string | Date | null;
}

export function computeContactStatus(c: StatusInput, at?: Date): ContactIntelStatus;
export function sendRestriction(c: StatusInput, at?: Date): SendRestriction | null;
