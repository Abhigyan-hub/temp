// Understanding one raw incoming message: is it a bounce, an automatic reply, or a person?
// Evidence order: delivery status reports (RFC 3464), then automatic-mail headers (RFC 3834),
// then threading headers. Subject lines are only ever used to tell an out-of-office from
// another automatic reply, after the headers have already shown it's automatic.

const unfold = (s) => s.replace(/\r?\n[ \t]+/g, " ");

/** Split a block of "Name: value" lines. Repeated headers keep their first value in `get`. */
export function parseHeaderBlock(block) {
  const map = new Map();
  for (const line of unfold(block).split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const name = line.slice(0, i).trim().toLowerCase();
    if (!map.has(name)) map.set(name, line.slice(i + 1).trim());
  }
  return map;
}

function splitHeaders(text) {
  const m = text.match(/\r?\n\r?\n/);
  return m ? [text.slice(0, m.index), text.slice(m.index + m[0].length)] : [text, ""];
}

/** The body of the MIME part with this content type, up to its next boundary (or the end). */
function partBody(text, contentTypeRe) {
  const re = new RegExp(`content-type:[ \\t]*(?:${contentTypeRe})[^\\r\\n]*(?:\\r?\\n[ \\t][^\\r\\n]*)*`, "i");
  const m = re.exec(text);
  if (!m) return null;
  const rest = text.slice(m.index);
  const blank = rest.match(/\r?\n\r?\n/);
  if (!blank) return null;
  const headers = rest.slice(0, blank.index);
  let body = rest.slice(blank.index + blank[0].length);
  const end = body.search(/\r?\n--[^\r\n]+/);
  if (end >= 0) body = body.slice(0, end);
  if (/content-transfer-encoding:[ \t]*base64/i.test(headers)) {
    body = Buffer.from(body.replace(/\s+/g, ""), "base64").toString("latin1");
  }
  return body;
}

const stripAddressType = (v) => String(v ?? "").replace(/^[a-z0-9-]+;\s*/i, "").replace(/[<>]/g, "").trim().toLowerCase();
const messageIdsIn = (v) => String(v ?? "").match(/<[^<>\s]+>/g) ?? [];

/** Fields of a message/delivery-status part, choosing the recipient block that failed. */
export function parseDeliveryStatus(raw) {
  const text = Buffer.isBuffer(raw) ? raw.toString("latin1") : String(raw);
  const body = partBody(text, "message/delivery-status|message/global-delivery-status");
  if (body === null) return null;
  const blocks = body.split(/\r?\n\r?\n/).map(parseHeaderBlock).filter((b) => b.size);
  const recipients = blocks.filter((b) => b.has("final-recipient") || b.has("action"));
  if (recipients.length === 0) return null;
  const chosen =
    recipients.find((b) => /failed/i.test(b.get("action") ?? "")) ??
    recipients.find((b) => /delayed/i.test(b.get("action") ?? "")) ??
    recipients[0];
  const statusCode = (chosen.get("status") ?? "").match(/\d\.\d{1,3}\.\d{1,3}/)?.[0] ?? "";
  return {
    finalRecipient: stripAddressType(chosen.get("final-recipient") ?? chosen.get("original-recipient")),
    action: (chosen.get("action") ?? "").toLowerCase(),
    status: statusCode,
    diagnostic: (chosen.get("diagnostic-code") ?? "").replace(/^[a-z]+;\s*/i, "").slice(0, 500),
    structured: true,
  };
}

/** The Message-ID of the email that bounced, from the returned copy inside the report. */
export function originalMessageId(raw) {
  const text = Buffer.isBuffer(raw) ? raw.toString("latin1") : String(raw);
  const body = partBody(text, "message/rfc822|text/rfc822-headers|message/global|message/rfc822-headers");
  if (body === null) return "";
  const [headers] = splitHeaders(body);
  return messageIdsIn(parseHeaderBlock(headers).get("message-id"))[0] ?? "";
}

const ADDRESS_GONE = /user unknown|no such user|does(?: |n.t |not )exist|unknown (?:user|recipient)|recipient not found|address rejected|mailbox not found|no mailbox|nxdomain|domain not found|host not found|bad destination/i;
const MAILBOX_TEMPORARY = /mailbox (?:is )?full|over quota|quota exceeded|insufficient storage|mailbox unavailable|temporarily/i;
const POLICY = /spam|blocked|blacklist|blocklist|policy|denied|not accepted|unsolicited|reputation/i;

/** Decide what a delivery report means. A temporary problem never counts as a permanent bounce. */
export function classifyDeliveryReport({ action, status, diagnostic }) {
  const [klass, subject, detail] = (status || "").split(".").map(Number);
  const text = diagnostic ?? "";

  if (klass === 4 || action === "delayed") {
    if (subject === 7) return "temporary_rejection";
    return "soft_bounce";
  }
  if (klass === 5) {
    if (subject === 2) return "soft_bounce"; // 5.2.x: mailbox full or disabled, may recover
    if (subject === 1) return "hard_bounce"; // 5.1.x: bad address or domain
    if (subject === 4 && (detail === 1 || detail === 4)) return "hard_bounce"; // no answer / unroutable
    if (subject === 7) return "rejected"; // refused for policy or spam reasons
    if (ADDRESS_GONE.test(text)) return "hard_bounce";
    return "rejected";
  }
  // No usable status code: read the server's own diagnostic text.
  if (ADDRESS_GONE.test(text)) return "hard_bounce";
  if (MAILBOX_TEMPORARY.test(text)) return "soft_bounce";
  if (POLICY.test(text)) return "rejected";
  return /failed/i.test(action ?? "") ? "rejected" : "soft_bounce";
}

const AUTOMATIC_SENDER = /^(?:mailer-daemon|postmaster|mail-daemon|mail\.?delivery)@/i;
const OOO_TEXT = /out of (?:the )?office|on vacation|on leave|away from (?:my|the) (?:desk|office|email)|annual leave|auto[- ]?reply: ?out/i;

export function isAutomaticReply(headers) {
  const auto = (headers.get("auto-submitted") ?? "").toLowerCase();
  if (auto && !auto.startsWith("no")) return true;
  if (headers.has("x-autoreply") || headers.has("x-autorespond") || headers.has("x-autoresponder")) return true;
  if (/^(?:reply|yes|true)/i.test(headers.get("x-autogenerated") ?? "")) return true;
  return /auto[_-]?reply/i.test(headers.get("precedence") ?? "");
}

/**
 * Everything MailFlow needs from a raw message. `text` is the decoded plain body, used for the
 * preview and to recognise non-standard bounce messages from a mail server.
 */
export function classifyMessage(raw, { subject = "", text = "" } = {}) {
  const source = Buffer.isBuffer(raw) ? raw.toString("latin1") : String(raw);
  const [headerText] = splitHeaders(source);
  const headers = parseHeaderBlock(headerText);
  const contentType = (headers.get("content-type") ?? "").toLowerCase();
  const fromHeader = (headers.get("from") ?? "").match(/<([^<>\s]+)>/)?.[1] ?? (headers.get("from") ?? "").trim();
  const threading = {
    messageId: messageIdsIn(headers.get("message-id"))[0] ?? "",
    inReplyTo: messageIdsIn(headers.get("in-reply-to"))[0] ?? "",
    references: messageIdsIn(headers.get("references")),
  };

  // Spam complaints (RFC 5965).
  if (/multipart\/report/.test(contentType) && /report-type="?feedback-report/.test(contentType)) {
    return { ...threading, classification: "complaint", originalMessageId: originalMessageId(source), bounce: null };
  }

  // Delivery status notifications: the structured source of truth.
  const report = /multipart\/report/.test(contentType) || /message\/delivery-status/i.test(source) ? parseDeliveryStatus(source) : null;
  if (report) {
    return { ...threading, classification: classifyDeliveryReport(report), originalMessageId: originalMessageId(source), bounce: report };
  }

  // Bounces from servers that don't send a proper report. Needs a daemon sender AND a matching failure text.
  const failedHeader = headers.get("x-failed-recipients");
  if (AUTOMATIC_SENDER.test(fromHeader) || failedHeader) {
    const diagnostic = (text.match(/^.*(?:\b[45]\d\d\b|user unknown|does(?:n.t| not) exist|mailbox).*$/im)?.[0] ?? "").trim().slice(0, 500);
    const finalRecipient = (failedHeader ?? "").split(",")[0].trim().toLowerCase();
    if (diagnostic || finalRecipient) {
      const bounce = { finalRecipient, action: "failed", status: diagnostic.match(/\b[245]\.\d{1,3}\.\d{1,3}\b/)?.[0] ?? "", diagnostic, structured: false };
      return { ...threading, classification: classifyDeliveryReport(bounce), originalMessageId: originalMessageId(source), bounce };
    }
    return { ...threading, classification: null, originalMessageId: "", bounce: null };
  }

  if (isAutomaticReply(headers)) {
    const isOoo = OOO_TEXT.test(subject) || OOO_TEXT.test(text.slice(0, 2000));
    return { ...threading, classification: isOoo ? "out_of_office" : "auto_reply", originalMessageId: "", bounce: null };
  }

  return { ...threading, classification: "human_reply", originalMessageId: "", bounce: null };
}
