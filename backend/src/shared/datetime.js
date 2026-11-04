// Shared with the web app (src/lib/datetime.ts) so server messages and the UI format dates alike.

/** "03 November 2026, 10:45 AM" in the given IANA timezone (falls back to the runtime's). */
export function formatDateTime(iso, timeZone) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  let parts;
  try {
    parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: timeZone || undefined,
      day: "2-digit",
      month: "long",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).formatToParts(date);
  } catch {
    return formatDateTime(iso); // unknown timezone string
  }
  const get = (type) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("day")} ${get("month")} ${get("year")}, ${get("hour")}:${get("minute")} ${get("dayPeriod").toUpperCase()}`;
}
