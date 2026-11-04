import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import os from "node:os";
import { env } from "../config/env.js";
import { Contact } from "../models/Contact.js";
import { EmailCampaign, EmailCampaignRecipient } from "../models/EmailCampaign.js";
import { EmailHistory } from "../models/EmailHistory.js";
import { Template } from "../models/Template.js";
import { User } from "../models/User.js";
import { AppError, notFound } from "../utils/AppError.js";
import { loadAttachments } from "./attachmentService.js";
import { releaseExpiredBlocks, restrictionFor } from "./blockService.js";
import { deliverToContact, isDryRun, sentInLast24h } from "./emailService.js";
import { resolveSender, senderChoiceOf } from "./senderService.js";

/*
 * A campaign is one "Send" click, run in the background one recipient at a time.
 * Everything is persisted as it happens, so progress survives a refresh or a closed browser.
 *
 * Duplicate safety:
 *  - A contact appears once per campaign (unique index).
 *  - Each recipient is claimed atomically (Waiting → Sending).
 *  - Only the lease holder runs a campaign; a stale lease means the server died and it's resumed.
 *  - A recipient found in Sending after a crash may already have gone out, so it's marked Failed
 *    with an explanation and only re-sent if the user chooses Retry.
 */

const WORKER_ID = `${os.hostname()}-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;
const LEASE_MS = 5 * 60 * 1000;
const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const bus = new EventEmitter();
bus.setMaxListeners(0);

/** Called whenever a campaign changes, for live streams on this instance. */
export function onCampaignChange(campaignId, listener) {
  const event = String(campaignId);
  bus.on(event, listener);
  return () => bus.off(event, listener);
}
const notify = (campaignId) => bus.emit(String(campaignId));

export const isTerminal = (status) => ["Completed", "Cancelled", "Failed"].includes(status);

/** Validate everything and queue the campaign. Bad attachments or a broken sender fail here, before any mail. */
export async function createCampaign(user, { templateId, contactIds, resumeIds = [], emailAccountId, campaignName, clientRequestId }) {
  const userId = user._id;

  if (clientRequestId) {
    const existing = await EmailCampaign.findOne({ userId, clientRequestId });
    if (existing) return { campaign: existing, reused: true };
  }

  const running = await EmailCampaign.findOne({ userId, status: { $in: ["Queued", "Running"] } });
  if (running) {
    const err = new AppError(409, "A send is already in progress. Wait for it to finish.");
    err.details = [{ field: "campaignId", message: String(running._id) }];
    throw err;
  }

  const template = await Template.findOne({ _id: templateId, userId });
  if (!template) throw notFound("Template");

  const ids = [...new Set(contactIds.map(String))];
  await releaseExpiredBlocks({ userId, _id: { $in: ids } });
  const contacts = await Contact.find({ _id: { $in: ids }, userId });
  if (contacts.length === 0) throw notFound("Contact");

  if ((await sentInLast24h(userId)) >= env.DAILY_SEND_LIMIT) {
    throw new AppError(429, `Daily limit of ${env.DAILY_SEND_LIMIT} emails reached. Try again tomorrow.`);
  }

  const sender = await resolveSender(user, emailAccountId);
  const attachments = await loadAttachments(userId, resumeIds);

  const byId = new Map(contacts.map((c) => [String(c._id), c]));
  const ordered = ids.map((id) => byId.get(id)).filter(Boolean);

  let campaign;
  try {
    campaign = await EmailCampaign.create({
      userId,
      campaignName: campaignName || `${template.name} · ${new Date().toISOString().slice(0, 10)}`,
      templateId,
      resumeIds: attachments.meta.map((m) => m.resumeId),
      emailAccountId: sender.accountId,
      usesSystem: emailAccountId === "system",
      senderEmail: sender.fromEmail,
      totalRecipients: ordered.length,
      dryRun: isDryRun(),
      ...(clientRequestId ? { clientRequestId } : {}),
    });
  } catch (err) {
    if (err?.code === 11000 && clientRequestId) {
      return { campaign: await EmailCampaign.findOne({ userId, clientRequestId }), reused: true };
    }
    throw err;
  }

  await EmailCampaignRecipient.insertMany(
    ordered.map((c, position) => ({
      campaignId: campaign._id,
      userId,
      contactId: c._id,
      position,
      recipientEmail: c.email,
      recipientName: c.name,
      company: c.company,
    })),
  );
  return { campaign, reused: false };
}

/** Take the lease. Only one worker can win, so a campaign never runs twice at once. */
async function claimCampaign(campaignId) {
  const now = new Date();
  return EmailCampaign.findOneAndUpdate(
    {
      _id: campaignId,
      $or: [{ status: "Queued" }, { status: "Running", heartbeatAt: { $lt: new Date(now.getTime() - LEASE_MS) } }],
    },
    { $set: { status: "Running", lockedBy: WORKER_ID, heartbeatAt: now, startedAt: now, statusMessage: "" } },
    { returnDocument: "after" },
  );
}

async function finishRecipient(recipient, status, patch, counter) {
  // Conditional on the state we saw, so two workers can't both count the same recipient.
  const { modifiedCount } = await EmailCampaignRecipient.updateOne({ _id: recipient._id, status: recipient.status }, { $set: { status, ...patch } });
  if (modifiedCount !== 1) return;
  await EmailCampaign.updateOne(
    { _id: recipient.campaignId },
    { $inc: { processedCount: 1, ...(counter ? { [counter]: 1 } : {}) }, $set: { heartbeatAt: new Date() } },
  );
  notify(recipient.campaignId);
}

/** Skip the rest when the campaign can't go on (cancelled, or a problem that affects everyone). */
async function closeRemaining(campaign, status, message, counter, retryable) {
  const waiting = await EmailCampaignRecipient.find({ campaignId: campaign._id, status: "Waiting" });
  for (const r of waiting) await finishRecipient(r, status, { errorMessage: message, retryable }, counter);
}

async function endCampaign(campaign, status, statusMessage = "") {
  await EmailCampaign.updateOne(
    { _id: campaign._id, lockedBy: WORKER_ID },
    { $set: { status, statusMessage, completedAt: new Date(), lockedBy: "", heartbeatAt: null } },
  );
  notify(campaign._id);
}

/**
 * Run a campaign to the end. Holds no state outside MongoDB except the attachment bytes,
 * which are fetched once per run and reused for every recipient.
 */
export async function runCampaign(campaignId, { delayMs = env.SEND_DELAY_MS } = {}) {
  const campaign = await claimCampaign(campaignId);
  if (!campaign) return null;
  notify(campaign._id);

  const user = await User.findById(campaign.userId);
  const template = await Template.findOne({ _id: campaign.templateId, userId: campaign.userId });
  if (!user || !template) {
    const message = !user ? "Account no longer exists" : "Template no longer exists";
    await closeRemaining(campaign, "Failed", message, "failedCount", false);
    await endCampaign(campaign, "Failed", message);
    return campaign._id;
  }

  // Sender and attachment problems stop the run: nobody gets a partial email or the wrong sender.
  let sender;
  let attachments;
  try {
    sender = await resolveSender(user, senderChoiceOf(campaign));
    attachments = await loadAttachments(campaign.userId, campaign.resumeIds);
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    await closeRemaining(campaign, "Failed", `Not sent: ${err.message}`, "failedCount", true);
    await endCampaign(campaign, "Failed", err.message);
    return campaign._id;
  }

  let sentToServer = 0;
  for (;;) {
    const current = await EmailCampaign.findById(campaign._id).select("cancelRequested");
    if (current?.cancelRequested) {
      await closeRemaining(campaign, "Cancelled", "Cancelled before sending", null, false);
      await endCampaign(campaign, "Cancelled");
      return campaign._id;
    }

    const recipient = await EmailCampaignRecipient.findOneAndUpdate(
      { campaignId: campaign._id, status: "Waiting" },
      { $set: { status: "Sending" }, $inc: { attempts: 1 } },
      { sort: { position: 1 }, returnDocument: "after" },
    );
    if (!recipient) break;
    await EmailCampaign.updateOne({ _id: campaign._id }, { $set: { heartbeatAt: new Date() } });
    notify(campaign._id);

    try {
      const contact = await Contact.findOne({ _id: recipient.contactId, userId: campaign.userId });
      if (!contact) {
        await finishRecipient(recipient, "Skipped", { errorMessage: "Contact no longer exists" }, "skippedCount");
        continue;
      }
      await releaseExpiredBlocks({ userId: campaign.userId, _id: contact._id });
      const fresh = (await Contact.findById(contact._id)) ?? contact;

      const restriction = restrictionFor(fresh, user.settings?.timezone);
      if (restriction) {
        await finishRecipient(recipient, "Skipped", { errorMessage: restriction.message, recipientEmail: fresh.email }, "skippedCount");
        continue;
      }
      const duplicate = await EmailHistory.exists({
        userId: campaign.userId,
        contactId: fresh._id,
        templateId: template._id,
        status: "Sent",
        sentAt: { $gte: new Date(Date.now() - DUPLICATE_WINDOW_MS) },
      });
      if (duplicate) {
        await finishRecipient(recipient, "Skipped", { errorMessage: "Already sent this template in the last 10 minutes", recipientEmail: fresh.email }, "skippedCount");
        continue;
      }
      if ((await sentInLast24h(campaign.userId)) >= env.DAILY_SEND_LIMIT) {
        await finishRecipient(recipient, "Skipped", { errorMessage: "Daily send limit reached", retryable: true, recipientEmail: fresh.email }, "skippedCount");
        continue;
      }

      if (sentToServer > 0 && delayMs) await sleep(delayMs);
      sentToServer++;

      const history = await deliverToContact({
        user,
        contact: fresh,
        template,
        source: "campaign",
        campaignId: campaign._id,
        attachments,
        sender,
      });
      if (history.status === "Sent") {
        await finishRecipient(
          recipient,
          "Accepted",
          { messageId: history.messageId, historyId: history._id, sentAt: history.sentAt, errorMessage: "", retryable: false, recipientEmail: fresh.email },
          "acceptedCount",
        );
      } else {
        await finishRecipient(
          recipient,
          "Failed",
          { historyId: history._id, errorMessage: history.errorMessage, retryable: !!history.retryable, recipientEmail: fresh.email },
          "failedCount",
        );
      }
    } catch (err) {
      console.error(`Campaign ${campaign._id}: recipient ${recipient._id} errored`, err?.message);
      await finishRecipient(recipient, "Failed", { errorMessage: "Unexpected error while sending", retryable: true }, "failedCount");
    }
  }

  await endCampaign(campaign, "Completed");
  return campaign._id;
}

/** Start in the background; the HTTP request doesn't wait for sending. */
export function startCampaign(campaignId) {
  runCampaign(campaignId).catch(async (err) => {
    console.error(`Campaign ${campaignId} crashed:`, err?.message);
    await EmailCampaign.updateOne(
      { _id: campaignId, lockedBy: WORKER_ID },
      { $set: { status: "Failed", statusMessage: "Unexpected error", completedAt: new Date(), lockedBy: "", heartbeatAt: null } },
    ).catch(() => {});
    notify(campaignId);
  });
}

/** Resume campaigns whose worker died, and queued ones that never started. */
export async function recoverCampaigns({ now = new Date(), start = startCampaign } = {}) {
  const staleBefore = new Date(now.getTime() - LEASE_MS);
  const queuedBefore = new Date(now.getTime() - 60 * 1000);
  const stuck = await EmailCampaign.find({
    $or: [
      { status: "Running", heartbeatAt: { $lt: staleBefore } },
      { status: "Queued", createdAt: { $lt: queuedBefore } },
    ],
  }).select("_id status");

  let recovered = 0;
  for (const { _id, status } of stuck) {
    // Requeue first: only one instance wins this, and it then owns the recovery.
    if (status === "Running") {
      const { modifiedCount } = await EmailCampaign.updateOne(
        { _id, status: "Running", heartbeatAt: { $lt: staleBefore } },
        { $set: { status: "Queued", lockedBy: "", heartbeatAt: null } },
      );
      if (modifiedCount !== 1) continue;
    }
    recovered++;
    const interrupted = await EmailCampaignRecipient.find({ campaignId: _id, status: "Sending" });
    for (const r of interrupted) {
      // It may have reached the server just before the crash, so it isn't re-sent automatically.
      const delivered = await EmailHistory.exists({ campaignId: _id, contactId: r.contactId, status: "Sent" });
      if (delivered) {
        await finishRecipient(r, "Accepted", { errorMessage: "", retryable: false }, "acceptedCount");
      } else {
        await finishRecipient(
          r,
          "Failed",
          { errorMessage: "Interrupted while sending. It may or may not have gone out; check your Sent folder before retrying.", retryable: true },
          "failedCount",
        );
      }
    }
    start(_id);
  }
  return recovered;
}

/** Put retryable failures back in the queue. Accepted recipients are never touched. */
export async function retryCampaign(userId, campaignId) {
  const campaign = await EmailCampaign.findOne({ _id: campaignId, userId });
  if (!campaign) throw notFound("Campaign");
  if (!isTerminal(campaign.status)) throw new AppError(409, "This campaign is still running.");
  const running = await EmailCampaign.exists({ userId, status: { $in: ["Queued", "Running"] } });
  if (running) throw new AppError(409, "Another send is in progress. Wait for it to finish.");

  const failed = await EmailCampaignRecipient.countDocuments({ campaignId, status: "Failed", retryable: true });
  const skipped = await EmailCampaignRecipient.countDocuments({ campaignId, status: "Skipped", retryable: true });
  if (failed + skipped === 0) throw new AppError(400, "There are no failed emails that can be retried.");

  await EmailCampaignRecipient.updateMany(
    { campaignId, status: { $in: ["Failed", "Skipped"] }, retryable: true },
    { $set: { status: "Waiting", errorMessage: "", retryable: false } },
  );
  const updated = await EmailCampaign.findOneAndUpdate(
    { _id: campaignId, userId },
    {
      $inc: { processedCount: -(failed + skipped), failedCount: -failed, skippedCount: -skipped },
      $set: { status: "Queued", statusMessage: "", completedAt: null, cancelRequested: false },
    },
    { returnDocument: "after" },
  );
  return { campaign: updated, retried: failed + skipped };
}
