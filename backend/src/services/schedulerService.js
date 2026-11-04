import crypto from "node:crypto";
import os from "node:os";
import cron from "node-cron";
import { env } from "../config/env.js";
import { Contact } from "../models/Contact.js";
import { ScheduledEmail } from "../models/ScheduledEmail.js";
import { Template } from "../models/Template.js";
import { User } from "../models/User.js";
import { AttachmentError, loadAttachments } from "./attachmentService.js";
import { AppError } from "../utils/AppError.js";
import { releaseExpiredBlocks, restrictionFor } from "./blockService.js";
import { recoverCampaigns } from "./campaignService.js";
import { deliverToContact, sentInLast24h } from "./emailService.js";
import { syncAllMailboxes } from "./incoming/imapSync.js";
import { resolveSender, senderChoiceOf } from "./senderService.js";

/*
 * MongoDB-backed scheduler.
 *
 * Every minute each backend instance claims due schedules one at a time with an atomic
 * findOneAndUpdate (Pending → Processing). Only one worker can win that update, so two
 * instances never send the same email.
 *
 * Crash safety: `sendingStartedAt` is written right before the SMTP call. A schedule stuck in
 * Processing without it never reached Gmail and is safely put back to Pending. One stuck *with*
 * it may or may not have been delivered, so it is marked Failed instead of risking a duplicate.
 */

const WORKER_ID = `${os.hostname()}-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;
const STALE_AFTER_MS = 10 * 60 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let task;
let inboxTask;
let running = false;

export async function recoverStale(now = new Date()) {
  const staleBefore = new Date(now.getTime() - STALE_AFTER_MS);
  const requeued = await ScheduledEmail.updateMany(
    { status: "Processing", lockedAt: { $lt: staleBefore }, sendingStartedAt: { $exists: false } },
    { $set: { status: "Pending" }, $unset: { lockedAt: 1, lockedBy: 1 } },
  );
  const failed = await ScheduledEmail.updateMany(
    { status: "Processing", lockedAt: { $lt: staleBefore }, sendingStartedAt: { $exists: true } },
    {
      $set: {
        status: "Failed",
        processedAt: now,
        errorMessage: "Interrupted while sending. Not retried to avoid a duplicate; check your Gmail Sent folder.",
      },
      $unset: { lockedAt: 1, lockedBy: 1 },
    },
  );
  return { requeued: requeued.modifiedCount, failed: failed.modifiedCount };
}

async function finish(schedule, patch) {
  await ScheduledEmail.updateOne(
    { _id: schedule._id, lockedBy: WORKER_ID },
    { $set: { ...patch, processedAt: new Date() }, $unset: { lockedAt: 1, lockedBy: 1 } },
  );
}

const MAX_ATTACHMENT_ATTEMPTS = 3;

/** Put a claimed schedule back to Pending for a later retry. */
async function defer(schedule, delayMs, errorMessage) {
  await ScheduledEmail.updateOne(
    { _id: schedule._id, lockedBy: WORKER_ID },
    {
      $set: { status: "Pending", scheduledAt: new Date(Date.now() + delayMs), errorMessage },
      $unset: { lockedAt: 1, lockedBy: 1 },
    },
  );
}

/**
 * Load a schedule's attachments, reusing files already fetched in this run.
 * Returns { attachments } or { outcome } when the schedule was failed/deferred instead.
 */
async function attachmentsFor(schedule, cache) {
  if (!schedule.resumeIds?.length) return { attachments: undefined };
  const key = `${schedule.userId}:${schedule.resumeIds.map(String).sort().join(",")}`;
  if (!cache.has(key)) cache.set(key, loadAttachments(schedule.userId, schedule.resumeIds));
  try {
    return { attachments: await cache.get(key) };
  } catch (err) {
    cache.delete(key);
    if (!(err instanceof AttachmentError)) throw err;
    // Storage hiccup: retry a few times. Missing / changed file: fail now — never send without it.
    if (err.transient && schedule.attempts < MAX_ATTACHMENT_ATTEMPTS) {
      await defer(schedule, 5 * 60 * 1000, `${err.message} Retrying in 5 minutes.`);
      return { outcome: "Deferred" };
    }
    await finish(schedule, { status: "Failed", errorMessage: `Not sent: ${err.message}` });
    return { outcome: "Failed" };
  }
}

/** Deliver one schedule this worker has already claimed. */
async function processClaimed(schedule, cache = new Map()) {
  const [user, contact, template] = await Promise.all([
    User.findById(schedule.userId),
    Contact.findOne({ _id: schedule.contactId, userId: schedule.userId }),
    Template.findOne({ _id: schedule.templateId, userId: schedule.userId }),
  ]);

  if (!user || !contact || !template) {
    const missing = !user ? "Account" : !contact ? "Contact" : "Template";
    await finish(schedule, { status: "Failed", errorMessage: `${missing} no longer exists` });
    return "Failed";
  }
  const restriction = restrictionFor(contact, user.settings?.timezone);
  if (restriction?.code === "soft_cooldown") {
    // Controlled retry: wait out the soft bounce rather than cancelling.
    await defer(schedule, new Date(restriction.retryAt).getTime() - Date.now(), restriction.message);
    return "Deferred";
  }
  if (restriction) {
    await finish(schedule, { status: "Cancelled", errorMessage: restriction.message });
    return "Cancelled";
  }

  // The chosen sender or nothing: a broken custom account never falls back to the system one.
  let sender;
  try {
    sender = await resolveSender(user, senderChoiceOf(schedule));
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    await finish(schedule, { status: "Failed", errorMessage: `Not sent: ${err.message}` });
    return "Failed";
  }
  if ((await sentInLast24h(user._id)) >= env.DAILY_SEND_LIMIT) {
    // Over the daily Gmail budget: push back an hour instead of failing.
    await defer(schedule, 60 * 60 * 1000, `Daily limit of ${env.DAILY_SEND_LIMIT} emails reached; retrying in an hour`);
    return "Deferred";
  }

  const { attachments, outcome } = await attachmentsFor(schedule, cache);
  if (outcome) return outcome;

  await ScheduledEmail.updateOne({ _id: schedule._id, lockedBy: WORKER_ID }, { $set: { sendingStartedAt: new Date() } });
  const history = await deliverToContact({
    user,
    contact,
    template,
    source: "scheduled",
    scheduleId: schedule._id,
    attachments,
    sender,
  });
  await finish(schedule, { status: history.status, errorMessage: history.errorMessage, historyId: history._id });
  return history.status;
}

function claim(filter) {
  return ScheduledEmail.findOneAndUpdate(
    { ...filter, status: "Pending" },
    { $set: { status: "Processing", lockedAt: new Date(), lockedBy: WORKER_ID }, $inc: { attempts: 1 } },
    { sort: { scheduledAt: 1 }, returnDocument: "after" },
  );
}

/** Claim and send due schedules, up to the batch size. */
export async function processDue({ limit = env.SCHEDULER_BATCH_SIZE, delayMs = env.SEND_DELAY_MS } = {}) {
  if (running) return { skipped: true };
  running = true;
  const summary = { processed: 0, Sent: 0, Failed: 0, Cancelled: 0, Deferred: 0 };
  // Attachments shared by several schedules in this run are downloaded once.
  const attachmentCache = new Map();
  try {
    await recoverStale();
    await releaseExpiredBlocks();
    for (let i = 0; i < limit; i++) {
      const schedule = await claim({ scheduledAt: { $lte: new Date() } });
      if (!schedule) break;
      if (summary.processed > 0 && delayMs) await sleep(delayMs);
      try {
        summary[await processClaimed(schedule, attachmentCache)]++;
      } catch (err) {
        console.error(`Scheduler: schedule ${schedule._id} errored`, err);
        await finish(schedule, { status: "Failed", errorMessage: "Unexpected error while sending" });
        summary.Failed++;
      }
      summary.processed++;
    }
  } finally {
    running = false;
  }
  if (summary.processed) console.log(`📬 Scheduler processed ${summary.processed}:`, summary);
  return summary;
}

/** Send a specific pending schedule immediately (the "Send now" button). */
export async function sendScheduleNow(scheduleId, userId) {
  const schedule = await claim({ _id: scheduleId, userId });
  if (!schedule) return null;
  try {
    await processClaimed(schedule);
  } catch (err) {
    console.error(err);
    await finish(schedule, { status: "Failed", errorMessage: "Unexpected error while sending" });
  }
  return ScheduledEmail.findById(scheduleId);
}

export function startScheduler() {
  if (task) return task;
  const tick = () => {
    processDue().catch((err) => console.error("Scheduler run failed", err));
    recoverCampaigns().catch((err) => console.error("Campaign recovery failed", err));
  };
  task = cron.schedule("* * * * *", tick);
  // Catch up immediately on boot: anything that came due while the server was down goes out now.
  tick();
  if (env.INBOX_SYNC_ENABLED) {
    const sync = () => syncAllMailboxes().catch((err) => console.error("Inbox sync failed", err?.message));
    inboxTask = cron.schedule(`*/${env.INBOX_SYNC_INTERVAL_MIN} * * * *`, sync);
    sync();
  }
  console.log(`⏰ Scheduler started (worker ${WORKER_ID})`);
  return task;
}

export function stopScheduler() {
  task?.stop();
  inboxTask?.stop();
  task = undefined;
  inboxTask = undefined;
}
