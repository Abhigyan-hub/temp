import nodemailer from "nodemailer";
import { env } from "../config/env.js";
import { EmailHistory } from "../models/EmailHistory.js";
import { cleanSubject, composeEmail, currentDateLabel, textToHtml } from "../utils/template.js";
import { isValidEmail } from "../utils/validators.js";
import { restrictionFor } from "./blockService.js";
import { recordSendAttempt } from "./contactIntel.js";

let transporter;

/** The system account's transport, configured only from server environment variables. */
export function getSystemTransport() {
  if (transporter) return transporter;
  transporter =
    env.EMAIL_TRANSPORT === "json"
      ? nodemailer.createTransport({ jsonTransport: true })
      : nodemailer.createTransport({
          host: env.GMAIL_HOST,
          port: env.GMAIL_PORT,
          secure: env.GMAIL_SECURE,
          pool: true,
          maxConnections: 1,
          auth: { user: env.GMAIL_USER, pass: env.GMAIL_PASS },
        });
  return transporter;
}

/** Test hook: swap in a fake transport. */
export function setTransporter(t) {
  transporter = t;
}

/** True when emails are only built, not delivered (EMAIL_TRANSPORT=json). */
export const isDryRun = () => env.EMAIL_TRANSPORT === "json";

export async function verifyTransport() {
  if (env.EMAIL_TRANSPORT === "json") return true;
  await getSystemTransport().verify();
  return true;
}

/** The default sender: the server's own account. */
export const systemSender = (user) => ({
  kind: "system",
  accountId: null,
  fromEmail: env.GMAIL_USER,
  fromName: user ? senderNameFor(user) : "",
  replyTo: "",
  transport: getSystemTransport(),
  label: "Gmail",
});

const responseText = (err) => String(err?.response ?? err?.message ?? "");

/**
 * What an SMTP failure means. Only `hard` says the address is bad.
 *   hard       the address doesn't exist           (5.1.x, "user unknown")
 *   rejected   the server refused this message     (5.7.x policy, other 5xx)
 *   temporary  try again later, about this address (450, 451, 452, 4.x.x)
 *   sender     our account is rate limited         (421, 454)
 *   message    the message itself is the problem   (552 too large)
 *   auth / network / other   our side; the contact is fine
 */
export function classifySmtpFailure(err) {
  if (err?.code === "EAUTH") return { kind: "auth", retryable: true };
  if (["ECONNECTION", "ETIMEDOUT", "ESOCKET", "EDNS", "ECONNREFUSED", "ENOTFOUND"].includes(err?.code)) return { kind: "network", retryable: true };
  const code = err?.responseCode;
  const text = responseText(err);
  const enhanced = text.match(/\b([245])\.(\d{1,3})\.(\d{1,3})\b/);
  if (code === 421 || code === 454) return { kind: "sender", retryable: true };
  if (code === 552) return { kind: "message", retryable: false };
  if (code >= 400 && code < 500) return { kind: "temporary", retryable: true };
  if (code >= 500) {
    if (enhanced && enhanced[1] === "5" && enhanced[2] === "1") return { kind: "hard", retryable: false };
    if (code === 553 || /user unknown|no such user|does not exist|unknown recipient|mailbox not found/i.test(text)) return { kind: "hard", retryable: false };
    return { kind: "rejected", retryable: false };
  }
  return { kind: "other", retryable: true };
}

function friendlySmtpError(err, label = "The mail server") {
  if (err?.code === "EAUTH") {
    return label === "Gmail"
      ? "Gmail rejected the login. Check GMAIL_USER / GMAIL_PASS (App Password)."
      : "The mail server rejected the login. Check the username and password of this email account.";
  }
  if (err?.responseCode === 550 || err?.responseCode === 553) return `Recipient rejected: ${err.response ?? err.message}`;
  if (err?.responseCode === 421 || err?.responseCode === 454) return `${label} is rate limiting this account. Try again later.`;
  if (err?.responseCode === 552) return `${label} rejected the message as too large. Attach fewer or smaller files.`;
  if (err?.responseCode >= 400 && err?.responseCode < 500) return `Temporarily refused, try again later: ${err.response ?? err.message}`;
  if (["ECONNECTION", "ETIMEDOUT", "ESOCKET", "EDNS", "ECONNREFUSED", "ENOTFOUND"].includes(err?.code)) {
    return label === "Gmail" ? "Could not reach Gmail's SMTP server." : "Could not reach the mail server. Check the host and port.";
  }
  return err?.message || "Email delivery failed";
}

const quoteName = (name) => `"${String(name).replace(/["\\\r\n]/g, "")}"`;

/**
 * Hand one email to an SMTP server. success means the server accepted it, not that it was delivered.
 * `attachments`: nodemailer attachments ({ filename, content: Buffer, contentType }) from attachmentService.
 */
export async function sendMail({ to, subject, text, fromName, attachments = [], sender }) {
  if (!isValidEmail(to)) return { success: false, error: "Invalid recipient email address", failureKind: "hard", retryable: false };
  const via = sender ?? systemSender();
  const name = fromName ?? via.fromName;
  try {
    const info = await via.transport.sendMail({
      from: name ? `${quoteName(name)} <${via.fromEmail}>` : via.fromEmail,
      to,
      subject: cleanSubject(subject),
      text,
      html: textToHtml(text),
      ...(via.replyTo ? { replyTo: via.replyTo } : {}),
      ...(attachments.length ? { attachments } : {}),
    });
    return { success: true, messageId: info.messageId ?? "" };
  } catch (err) {
    const { kind, retryable } = classifySmtpFailure(err);
    return { success: false, error: friendlySmtpError(err, via.label), failureKind: kind, retryable };
  }
}

export const senderNameFor = (user) => user.profile?.senderName?.trim() || user.name;

/** Values for {{senderName}}, {{senderEmail}}, {{signature}} and {{currentDate}}. */
export const senderVariables = (user, sender) => ({
  senderName: sender?.fromName || senderNameFor(user),
  senderEmail: sender?.fromEmail ?? env.GMAIL_USER,
  signature: user.profile?.signature ?? "",
  currentDate: currentDateLabel(user.settings?.timezone),
});

export async function sentInLast24h(userId) {
  return EmailHistory.countDocuments({
    userId,
    status: "Sent",
    sentAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
  });
}

/**
 * Personalise a template for one contact, send it, record history and update the contact.
 * Never throws for delivery problems; the outcome is in the returned history record.
 * `attachments` ({ files, meta }) comes from attachmentService.loadAttachments, already verified.
 * `sender` comes from senderService.resolveSender; it never falls back to another account.
 */
export async function deliverToContact({ user, contact, template, source = "manual", scheduleId, campaignId, attachments, sender }) {
  const via = sender ?? systemSender(user);
  const { subject: rendered, body } = composeEmail(template, contact, senderVariables(user, via));
  const subject = cleanSubject(rendered);

  const restriction = restrictionFor(contact, user.settings?.timezone);
  let result;
  if (restriction) result = { success: false, error: restriction.message, failureKind: "restricted", retryable: false };
  else if (!subject) result = { success: false, error: "Subject is empty after personalisation", failureKind: "message", retryable: false };
  else {
    result = await sendMail({
      to: contact.email,
      subject,
      text: body,
      fromName: via.fromName || senderNameFor(user),
      attachments: attachments?.files ?? [],
      sender: via,
    });
  }

  const now = new Date();
  const history = await EmailHistory.create({
    userId: user._id,
    contactId: contact._id,
    templateId: template._id,
    templateName: template.name,
    scheduleId,
    campaignId,
    emailAccountId: via.accountId,
    senderEmail: via.fromEmail,
    recipient: contact.email,
    subject: subject || "(empty subject)",
    body,
    status: result.success ? "Sent" : "Failed",
    errorMessage: result.success ? "" : result.error,
    failureKind: result.success ? "" : result.failureKind,
    messageId: result.messageId ?? "",
    dryRun: isDryRun(),
    source,
    attachments: attachments?.meta ?? [],
    sentAt: now,
  });

  // A refused-by-rules attempt never reached a server and says nothing about the address.
  if (result.failureKind !== "restricted") {
    await recordSendAttempt({ contactId: contact._id, userId: user._id, history, failureKind: result.failureKind });
  }
  history.retryable = !!result.retryable;
  return history;
}
