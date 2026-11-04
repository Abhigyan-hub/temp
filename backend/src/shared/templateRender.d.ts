export const CONTACT_VARIABLES: string[];
export const SENDER_VARIABLES: string[];

type Values = object;

export function renderTemplate(str: string | null | undefined, contact: Values | null | undefined, sender?: Values): string;
export function currentDateLabel(timeZone?: string, now?: Date): string;
export function composeEmail(
  template: { subject?: string; body?: string } | null | undefined,
  contact: Values | null | undefined,
  sender?: Values,
): { subject: string; body: string };
export function insertAtCursor(value: string, start?: number | null, end?: number | null, text?: string): { value: string; cursor: number };
