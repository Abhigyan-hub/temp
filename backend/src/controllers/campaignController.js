import { z } from "zod";
import { env } from "../config/env.js";
import { EmailCampaign, EmailCampaignRecipient } from "../models/EmailCampaign.js";
import { createCampaign, isTerminal, onCampaignChange, retryCampaign, startCampaign } from "../services/campaignService.js";
import { notFound } from "../utils/AppError.js";
import { objectId } from "../utils/validators.js";

export const schemas = {
  create: z.object({
    templateId: objectId,
    contactIds: z
      .array(objectId)
      .min(1, "Select at least one contact")
      .max(env.MAX_RECIPIENTS_PER_SEND, `Send to at most ${env.MAX_RECIPIENTS_PER_SEND} contacts at a time`),
    resumeIds: z.array(objectId).max(env.ATTACHMENT_MAX_COUNT, `Attach at most ${env.ATTACHMENT_MAX_COUNT} resumes`).optional().default([]),
    emailAccountId: z.string().max(40).optional(),
    campaignName: z.string().trim().max(200).optional(),
    clientRequestId: z.string().trim().min(8).max(80).optional(),
  }),
  list: z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }),
};

const ownCampaign = async (req) => {
  const campaign = await EmailCampaign.findOne({ _id: req.params.id, userId: req.user._id });
  if (!campaign) throw notFound("Campaign");
  return campaign;
};

export const campaignView = (c) => ({ ...c.toJSON(), remaining: Math.max(0, c.totalRecipients - c.processedCount) });

const recipientsOf = (campaignId) => EmailCampaignRecipient.find({ campaignId }).sort({ position: 1 });

export async function create(req, res) {
  const { campaign, reused } = await createCampaign(req.user, req.body);
  if (!reused) startCampaign(campaign._id);
  res.status(reused ? 200 : 202).json({ success: true, campaign: campaignView(campaign), recipients: await recipientsOf(campaign._id) });
}

export async function list(req, res) {
  const campaigns = await EmailCampaign.find({ userId: req.user._id }).sort({ createdAt: -1 }).limit(req.validatedQuery.limit);
  res.json({ success: true, campaigns: campaigns.map(campaignView) });
}

/** The user's campaign in progress, so the tracker comes back after a refresh. */
export async function active(req, res) {
  const campaign = await EmailCampaign.findOne({ userId: req.user._id, status: { $in: ["Queued", "Running"] } }).sort({ createdAt: -1 });
  if (!campaign) return res.json({ success: true, campaign: null, recipients: [] });
  res.json({ success: true, campaign: campaignView(campaign), recipients: await recipientsOf(campaign._id) });
}

export async function progress(req, res) {
  const campaign = await ownCampaign(req);
  res.json({ success: true, campaign: campaignView(campaign), recipients: await recipientsOf(campaign._id) });
}

export async function cancel(req, res) {
  const campaign = await EmailCampaign.findOneAndUpdate(
    { _id: req.params.id, userId: req.user._id, status: { $in: ["Queued", "Running"] } },
    { $set: { cancelRequested: true } },
    { returnDocument: "after" },
  );
  if (!campaign) throw notFound("Running campaign");
  res.json({ success: true, campaign: campaignView(campaign) });
}

export async function retry(req, res) {
  const { campaign, retried } = await retryCampaign(req.user._id, req.params.id);
  startCampaign(campaign._id);
  res.status(202).json({ success: true, retried, campaign: campaignView(campaign), recipients: await recipientsOf(campaign._id) });
}

/**
 * Server-Sent Events. Sends a full snapshot, then each change. It only reads MongoDB, so closing
 * the stream has no effect on sending, and a campaign running on another instance still streams.
 */
export async function events(req, res) {
  const campaign = await ownCampaign(req);

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  send("snapshot", { campaign: campaignView(campaign), recipients: await recipientsOf(campaign._id) });

  let closed = false;
  let since = new Date();
  let flushing = false;
  let pending = false;

  const finish = () => {
    if (closed) return;
    closed = true;
    clearInterval(poll);
    clearInterval(keepAlive);
    unsubscribe();
    res.end();
  };

  const flush = async () => {
    if (closed) return;
    if (flushing) {
      pending = true;
      return;
    }
    flushing = true;
    try {
      const startedAt = new Date();
      const current = await EmailCampaign.findById(campaign._id);
      if (!current || closed) return;
      // Slight overlap so a change landing mid-read is sent again rather than lost.
      const changed = await EmailCampaignRecipient.find({ campaignId: campaign._id, updatedAt: { $gte: new Date(since.getTime() - 1000) } }).sort({ position: 1 });
      since = startedAt;
      send("progress", { campaign: campaignView(current), recipients: changed });
      if (isTerminal(current.status)) {
        send("done", { campaign: campaignView(current) });
        finish();
      }
    } catch (err) {
      console.error("Campaign stream error:", err?.message);
    } finally {
      flushing = false;
      if (pending && !closed) {
        pending = false;
        flush();
      }
    }
  };

  const unsubscribe = onCampaignChange(campaign._id, flush);
  const poll = setInterval(flush, 2000);
  const keepAlive = setInterval(() => !closed && res.write(": keep-alive\n\n"), 15000);
  req.on("close", finish);
  flush();
}
