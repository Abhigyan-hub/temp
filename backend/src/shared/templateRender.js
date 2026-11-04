// Template rendering shared by the API (real sends) and the web app (live preview), so a preview
// shows exactly what goes out. Types: templateRender.d.ts.

export const CONTACT_VARIABLES = ["name", "email", "title", "company", "category"];
export const SENDER_VARIABLES = ["senderName", "senderEmail", "signature", "currentDate"];

const PATTERN = /\{\{\s*(name|title|company|category|email|senderName|senderEmail|signature|currentDate)\s*(?:\|([^}]*))?\}\}/g;

/**
 * Replace {{field}} with contact / sender values. {{name|there}} gives "there" when name is blank;
 * a blank variable without a fallback becomes empty text. Unknown {{variables}} are left untouched.
 */
export function renderTemplate(str, contact, sender = {}) {
  return String(str ?? "").replace(PATTERN, (_, key, fallback) => {
    const source = SENDER_VARIABLES.includes(key) ? sender : contact;
    const value = String(source?.[key] ?? "").trim();
    return value || (fallback ?? "").trim();
  });
}

/** "04 November 2026" in the given timezone. */
export function currentDateLabel(timeZone, now = new Date()) {
  const format = (tz) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, day: "2-digit", month: "long", year: "numeric" }).format(now);
  try {
    return format(timeZone || undefined);
  } catch {
    return format(undefined);
  }
}

const usesSignature = (str) => /\{\{\s*signature\s*(\|[^}]*)?\}\}/.test(String(str ?? ""));

/**
 * The final subject and body for one contact. The signature is appended automatically
 * unless the template already places it with {{signature}}.
 */
export function composeEmail(template, contact, sender = {}) {
  const subject = renderTemplate(template?.subject, contact, sender).replace(/[\r\n]+/g, " ").trim().slice(0, 300);
  let body = renderTemplate(template?.body, contact, sender);
  const signature = String(sender?.signature ?? "").trim();
  if (signature && !usesSignature(template?.body)) body = `${body.trimEnd()}\n\n${signature}`;
  return { subject, body };
}

/** Insert text at a cursor / selection. Returns the new value and where the cursor goes. */
export function insertAtCursor(value, start, end, text) {
  const v = String(value ?? "");
  const from = Math.max(0, Math.min(start ?? v.length, v.length));
  const to = Math.max(from, Math.min(end ?? from, v.length));
  return { value: v.slice(0, from) + text + v.slice(to), cursor: from + text.length };
}
