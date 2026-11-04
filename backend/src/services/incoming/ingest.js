import { createHash } from "node:crypto";
import { simpleParser } from "mailparser";
import { Contact } from "../../models/Contact.js";
import { EmailCampaignRecipient } from "../../models/EmailCampaign.js";
import { EmailHistory } from "../../models/EmailHistory.js";
import { IncomingEmail } from "../../models/IncomingEmail.js";
import { recordIncoming } from "../contactIntel.js";
import { classifyMessage } from "./classify.js";

const OUTCOMES = {
  hard_bounce: "Hard bounced",
  soft_bounce: "Soft bounced",
  temporary_rejection: "Temporarily rejected",
  rejected: "Rejected",
  complaint: "Spam complaint",
  auto_reply: "Auto replied",
  out_of_office: "Out of office",
  human_reply: "Replied",
};

/**
 * Find the email MailFlow sent that this message refers to. The account decides whose history is
 * searched: a custom account belongs to one user, the system account to whoever sent through it.
 */
async function findRelatedEmail(account, parsed, { senderEmail, receivedAt }) {
  const scope = account.userId
    ? { userId: account.userId, emailAccountId: account.accountId }
    : { emailAccountId: null };

  const byMessageId = (ids) => EmailHistory.findOne({ ...scope, messageId: { $in: ids } }).sort({ sentAt: -1 });

  if (parsed.originalMessageId) {
    const h = await byMessageId([parsed.originalMessageId]);
    if (h) return { history: h, matchedBy: "original-message-id" };
  }
  if (parsed.inReplyTo) {
    const h = await byMessageId([parsed.inReplyTo]);
    if (h) return { history: h, matchedBy: "in-reply-to" };
  }
  if (parsed.references.length) {
    const h = await byMessageId(parsed.references);
    if (h) return { history: h, matchedBy: "references" };
  }

  // Bounce without a returned copy: the address it failed for, latest email first.
  const isBounce = !!parsed.bounce;
  const address = isBounce ? parsed.bounce.finalRecipient : senderEmail;
  if (!address) return null;
  const candidates = await EmailHistory.find({ ...scope, recipient: address, status: "Sent", sentAt: { $lte: receivedAt } })
    .sort({ sentAt: -1 })
    .limit(5);
  if (candidates.length === 0) return null;
  // On the shared system account only trust this when all candidates belong to one user.
  const owners = new Set(candidates.map((h) => String(h.userId)));
  if (owners.size > 1) return null;
  return { history: candidates[0], matchedBy: isBounce ? "recipient" : "sender" };
}

/**
 * Process one raw message from a mailbox. Only mail tied to something MailFlow sent is stored;
 * the rest of the inbox is ignored and never written anywhere.
 * Returns { stored, reason, classification }.
 */
export async function ingestRawMessage(account, raw, { receivedAt } = {}) {
  const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  const mail = await simpleParser(buffer, { skipHtmlToText: false, skipImageLinks: true, skipTextLinks: true }).catch(() => null);
  const subject = mail?.subject ?? "";
  const text = mail?.text ?? "";
  const parsed = classifyMessage(buffer, { subject, text });
  if (!parsed.classification) return { stored: false, reason: "unrecognised" };

  const senderEmail = (mail?.from?.value?.[0]?.address ?? "").toLowerCase();
  const when = receivedAt ?? mail?.date ?? new Date();

  // Our own outgoing mail landing in the inbox (e.g. sending to yourself) is not a reply.
  if (senderEmail && senderEmail === String(account.label ?? "").toLowerCase()) return { stored: false, reason: "own-message" };
  if (parsed.messageId && (await EmailHistory.exists({ messageId: parsed.messageId }))) return { stored: false, reason: "own-message" };

  const related = await findRelatedEmail(account, parsed, { senderEmail, receivedAt: when });
  if (!related) return { stored: false, reason: "unrelated", classification: parsed.classification };

  const { history, matchedBy } = related;
  const contact = history.contactId ? await Contact.findOne({ _id: history.contactId, userId: history.userId }) : null;
  if (!contact) return { stored: false, reason: "no-contact", classification: parsed.classification };

  // Without its own Message-ID, identify the message by content so re-reading it is still a duplicate.
  const messageId = parsed.messageId || `<sha256-${createHash("sha256").update(buffer).digest("hex")}@mailflow.local>`;

  let incoming;
  try {
    incoming = await IncomingEmail.create({
      userId: history.userId,
      accountKey: account.key,
      senderEmail,
      recipientEmail: (mail?.to?.value?.[0]?.address ?? "").toLowerCase(),
      subject: subject.slice(0, 500),
      bodyPreview: text.replace(/\s+/g, " ").trim().slice(0, 300),
      messageId,
      inReplyTo: parsed.inReplyTo,
      references: parsed.references,
      classification: parsed.classification,
      matchedBy,
      bounce: parsed.bounce ?? undefined,
      relatedContactId: contact._id,
      relatedEmailId: history._id,
      receivedAt: when,
    });
  } catch (err) {
    if (err?.code === 11000) return { stored: false, reason: "duplicate", classification: parsed.classification };
    throw err;
  }

  await recordIncoming({ contact, incoming, history, at: when });

  const outcome = OUTCOMES[parsed.classification];
  await EmailHistory.updateOne({ _id: history._id }, { $set: { outcome, outcomeAt: when } });
  if (history.campaignId) {
    await EmailCampaignRecipient.updateOne({ campaignId: history.campaignId, contactId: contact._id }, { $set: { outcome } });
  }
  return { stored: true, classification: parsed.classification, contactId: contact._id, incomingId: incoming._id };
}
