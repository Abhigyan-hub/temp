import { ImapFlow } from "imapflow";
import { env } from "../../config/env.js";
import { EmailAccount } from "../../models/EmailAccount.js";
import { MailboxSyncState } from "../../models/MailboxSyncState.js";
import { decryptSecret } from "../../utils/crypto.js";
import { assertPublicHost } from "../../utils/netGuard.js";
import { ingestRawMessage } from "./ingest.js";

/*
 * Polls INBOX over IMAP: read-only, so nothing is marked read, moved or deleted.
 * Works with the same App Password used for SMTP, so it needs no Google Cloud project.
 * Progress is kept per mailbox as the last UID seen, so a message is read once.
 */

const MAX_MESSAGES_PER_RUN = 200;
// Delivery reports put their status before the returned copy, so the start of a message is enough
// and attachments are never downloaded.
const MAX_MESSAGE_BYTES = 256 * 1024;
const LEASE_MS = 5 * 60 * 1000;

/** Test hook: how an IMAP client is created. */
let clientFactory = (cfg) =>
  new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: true,
    auth: { user: cfg.user, pass: cfg.pass },
    logger: false,
    socketTimeout: 60000,
    connectionTimeout: 20000,
    greetingTimeout: 15000,
  });

export function setImapClientFactory(factory) {
  clientFactory = factory;
}

/** Mailboxes to read: the system account (if enabled) and users' accounts with reading turned on. */
export async function listInboundAccounts({ onlySystemAnd } = {}) {
  const accounts = [
    { key: "system", userId: null, accountId: null, host: env.GMAIL_IMAP_HOST, port: env.GMAIL_IMAP_PORT, user: env.GMAIL_USER, pass: () => env.GMAIL_PASS, label: env.GMAIL_USER },
  ];
  // onlySystemAnd limits users' own mailboxes to one user ("Sync now").
  const own = await EmailAccount.find({ imapEnabled: true, imapHost: { $ne: "" }, ...(onlySystemAnd ? { userId: onlySystemAnd } : {}) }).select("+passwordEncrypted");
  for (const a of own) {
    accounts.push({
      key: String(a._id),
      userId: a.userId,
      accountId: a._id,
      host: a.imapHost,
      port: a.imapPort,
      user: a.smtpUsername,
      pass: () => decryptSecret(a.passwordEncrypted),
      label: a.senderEmail,
    });
  }
  return accounts;
}

async function acquireLease(key) {
  const now = new Date();
  await MailboxSyncState.updateOne({ accountKey: key }, { $setOnInsert: { accountKey: key } }, { upsert: true }).catch((err) => {
    if (err?.code !== 11000) throw err;
  });
  return MailboxSyncState.findOneAndUpdate(
    { accountKey: key, $or: [{ lockedUntil: null }, { lockedUntil: { $lt: now } }] },
    { $set: { lockedUntil: new Date(now.getTime() + LEASE_MS) } },
    { returnDocument: "after" },
  );
}

/** Sync one mailbox. Failures are recorded on its state, never thrown at the caller. */
export async function syncMailbox(account) {
  const state = await acquireLease(account.key);
  if (!state) return { key: account.key, skipped: true };

  const result = { key: account.key, scanned: 0, stored: 0, duplicates: 0 };
  const client = await Promise.resolve().then(async () => {
    await assertPublicHost(account.host);
    return clientFactory({ host: account.host, port: account.port, user: account.user, pass: account.pass() });
  }).catch((err) => err);

  if (client instanceof Error) {
    await MailboxSyncState.updateOne({ accountKey: account.key }, { $set: { lastError: client.message, lockedUntil: null, lastSyncAt: new Date() } });
    return { ...result, error: client.message };
  }

  let lastUid = state.lastUid;
  let uidValidity = state.uidValidity;
  let lastError = "";
  let lock;
  // Keep unexpected socket errors from crashing the process; the awaited calls report them.
  client.on?.("error", () => {});

  try {
    await client.connect();
    lock = await client.getMailboxLock("INBOX", { readOnly: true });
    const currentValidity = String(client.mailbox?.uidValidity ?? "");
    const resetting = uidValidity !== currentValidity;
    if (resetting) lastUid = 0;
    uidValidity = currentValidity;

    let uids;
    if (lastUid > 0) {
      uids = await client.search({ uid: `${lastUid + 1}:*` }, { uid: true });
    } else {
      const since = new Date(Date.now() - env.INBOX_SYNC_DAYS * 24 * 60 * 60 * 1000);
      uids = await client.search({ since }, { uid: true });
    }
    // "n:*" always includes the newest message, even if it's already been seen.
    uids = (uids || []).filter((u) => u > lastUid).sort((a, b) => a - b).slice(0, MAX_MESSAGES_PER_RUN);

    if (uids.length) {
      const messages = [];
      for await (const m of client.fetch(uids.join(","), { uid: true, internalDate: true, source: { start: 0, maxLength: MAX_MESSAGE_BYTES } }, { uid: true })) {
        messages.push({ uid: m.uid, source: m.source, internalDate: m.internalDate });
      }
      for (const m of messages.sort((a, b) => a.uid - b.uid)) {
        result.scanned++;
        if (m.source?.length) {
          const r = await ingestRawMessage(account, m.source, { receivedAt: m.internalDate ? new Date(m.internalDate) : undefined });
          if (r.stored) result.stored++;
          if (r.reason === "duplicate") result.duplicates++;
        }
        lastUid = Math.max(lastUid, m.uid);
      }
      // Nothing to process but the search moved on (e.g. empty sources).
      lastUid = Math.max(lastUid, uids.at(-1));
    }
  } catch (err) {
    lastError = err?.authenticationFailed
      ? "The mail server rejected the login. Check the App Password."
      : err?.message || "Inbox sync failed";
    result.error = lastError;
  } finally {
    lock?.release?.();
    await client.logout?.().catch(() => {});
  }

  await MailboxSyncState.updateOne(
    { accountKey: account.key },
    { $set: { lastUid, uidValidity, lastError, lastSyncAt: new Date(), lastMatched: result.stored, lockedUntil: null } },
  );
  return result;
}

export async function syncAllMailboxes(filter = {}) {
  const accounts = await listInboundAccounts(filter);
  const results = [];
  for (const account of accounts) results.push(await syncMailbox(account));
  const stored = results.reduce((n, r) => n + (r.stored ?? 0), 0);
  if (stored) console.log(`📥 Inbox sync: ${stored} new replies or bounce notifications`);
  return results;
}

/** Safe summary for the UI: never includes credentials. */
export async function syncStatus(userId) {
  const accounts = await EmailAccount.find({ userId, imapEnabled: true }).select("senderEmail");
  const rows = [
    { key: "system", label: env.GMAIL_USER, enabled: env.INBOX_SYNC_ENABLED },
    ...accounts.map((a) => ({ key: String(a._id), label: a.senderEmail, enabled: env.INBOX_SYNC_ENABLED })),
  ];
  const states = await MailboxSyncState.find({ accountKey: { $in: rows.map((r) => r.key) } });
  const byKey = new Map(states.map((s) => [s.accountKey, s]));
  return rows.map((r) => {
    const s = byKey.get(r.key);
    return { ...r, lastSyncAt: s?.lastSyncAt ?? null, lastError: s?.lastError ?? "", lastMatched: s?.lastMatched ?? 0 };
  });
}
