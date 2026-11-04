// Contact intelligence, live campaigns, sender accounts and inbox sync.
// Real MongoDB (`mailflow_test_intel`, dropped afterwards). Every mail transport and IMAP client is
// fake; the GMAIL_* values below point nowhere, so nothing can reach a real account.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import "dotenv/config";

process.env.MONGODB_URI = process.env.MONGODB_URI.replace(/\/([^/?]*)(\?|$)/, "/mailflow_test_intel$2");
process.env.NODE_ENV = "test";
process.env.EMAIL_TRANSPORT = "smtp"; // counters only move for real (here: faked) SMTP, not dry runs
process.env.GMAIL_USER = "system@mailflow.test";
process.env.GMAIL_PASS = "not-a-real-password";
process.env.GMAIL_HOST = "127.0.0.1";
process.env.GMAIL_PORT = "1";
process.env.GMAIL_IMAP_HOST = "127.0.0.1";
process.env.SEND_DELAY_MS = "0";
process.env.SCHEDULER_ENABLED = "false";
process.env.INBOX_SYNC_ENABLED = "true";
process.env.STORAGE_DRIVER = "local";
process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("hex");
process.env.DAILY_SEND_LIMIT = "400";

const mongoose = (await import("mongoose")).default;
const { connectDB, disconnectDB } = await import("../src/config/db.js");
const { createApp } = await import("../src/app.js");
const { setTransporter, classifySmtpFailure } = await import("../src/services/emailService.js");
const { setCustomTransportFactory } = await import("../src/services/senderService.js");
const { setImapClientFactory, syncMailbox, listInboundAccounts } = await import("../src/services/incoming/imapSync.js");
const { ingestRawMessage } = await import("../src/services/incoming/ingest.js");
const { recoverCampaigns, runCampaign } = await import("../src/services/campaignService.js");
const { processDue } = await import("../src/services/schedulerService.js");
const { backfillContactIntel } = await import("../src/services/contactIntel.js");
const { setStorage } = await import("../src/services/storage/index.js");
const { createLocalStorage } = await import("../src/services/storage/local.js");
const { encryptSecret, decryptSecret } = await import("../src/utils/crypto.js");
const { isPrivateAddress } = await import("../src/utils/netGuard.js");
const { composeEmail, insertAtCursor, renderTemplate } = await import("../src/shared/templateRender.js");
const { computeContactStatus, sendRestriction } = await import("../src/shared/contactStatus.js");
const { Contact } = await import("../src/models/Contact.js");
const { ContactActivity } = await import("../src/models/ContactActivity.js");
const { EmailAccount } = await import("../src/models/EmailAccount.js");
const { EmailCampaign, EmailCampaignRecipient } = await import("../src/models/EmailCampaign.js");
const { EmailHistory } = await import("../src/models/EmailHistory.js");
const { IncomingEmail } = await import("../src/models/IncomingEmail.js");
const { MailboxSyncState } = await import("../src/models/MailboxSyncState.js");
const { ScheduledEmail } = await import("../src/models/ScheduledEmail.js");

// ---------- fakes ----------

const outbox = [];
let nextId = 0;
const respond = (msg, via) => {
  if (/^hard/.test(msg.to)) throw Object.assign(new Error("rejected"), { responseCode: 550, response: "550 5.1.1 no such user" });
  if (/^temp/.test(msg.to)) throw Object.assign(new Error("later"), { responseCode: 451, response: "451 4.3.0 try later" });
  if (/^policy/.test(msg.to)) throw Object.assign(new Error("no"), { responseCode: 550, response: "550 5.7.1 blocked by policy" });
  if (/^network/.test(msg.to)) throw Object.assign(new Error("down"), { code: "ECONNECTION" });
  const messageId = `<fake-${++nextId}@mailflow.test>`;
  outbox.push({ ...msg, via, messageId });
  return { messageId };
};
setTransporter({ sendMail: async (msg) => respond(msg, "system"), verify: async () => true });

let customBehaviour = {};
const customTransportsCreated = [];
setCustomTransportFactory((account, password) => {
  customTransportsCreated.push({ host: account.smtpHost, password });
  return {
    sendMail: async (msg) => {
      if (customBehaviour.authFails) throw Object.assign(new Error("bad login"), { code: "EAUTH" });
      return respond(msg, account.senderEmail);
    },
    verify: async () => {
      if (customBehaviour.authFails) throw Object.assign(new Error("bad login"), { code: "EAUTH" });
      return true;
    },
  };
});

const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "mailflow-intel-"));
setStorage(createLocalStorage(storageDir));

let server;
let url;

function client() {
  let cookie = "";
  const call = async (method, p, body, { raw = false } = {}) => {
    const isForm = body instanceof FormData;
    const res = await fetch(url + p, {
      method,
      headers: {
        "x-requested-with": "mailflow",
        ...(body && !isForm ? { "content-type": "application/json" } : {}),
        ...(cookie ? { cookie } : {}),
      },
      body: isForm ? body : body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    if (raw) return res;
    const json = await res.json().catch(() => ({}));
    return { status: res.status, ...json };
  };
  return call;
}

const alice = client();
const bob = client();
let aliceId;
let template;

const addContact = async (email, extra = {}) => (await alice("POST", "/mailflow/contacts", { email, ...extra })).contact;
const getContact = async (id) => (await alice("GET", `/mailflow/contacts/${id}`)).contact;

/** Run a campaign synchronously by waiting until it's terminal. */
async function waitForCampaign(call, id, ms = 15000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const r = await call("GET", `/mailflow/campaigns/${id}/progress`);
    if (["Completed", "Failed", "Cancelled"].includes(r.campaign.status)) return r;
    if (Date.now() > deadline) throw new Error("campaign did not finish");
    await new Promise((res) => setTimeout(res, 50));
  }
}

async function send(contactIds, extra = {}) {
  const r = await alice("POST", "/mailflow/campaigns", { templateId: template.id, contactIds, ...extra });
  assert.equal(r.status, 202, r.message);
  return waitForCampaign(alice, r.campaign.id);
}

const clearDuplicateWindow = () => EmailHistory.updateMany({}, { $set: { sentAt: new Date(Date.now() - 3600e3) } });

const bounceFor = ({ recipient, original, status = "5.1.1", id = randomBytes(4).toString("hex") }) =>
  [
    "From: Mail Delivery Subsystem <mailer-daemon@googlemail.com>",
    "To: system@mailflow.test",
    "Subject: Delivery Status Notification (Failure)",
    `Message-ID: <dsn-${id}@mx.google.com>`,
    "Date: Wed, 04 Nov 2026 10:00:00 +0000",
    'Content-Type: multipart/report; boundary="bbb"; report-type=delivery-status',
    "",
    "--bbb",
    "Content-Type: text/plain",
    "",
    "Delivery failed",
    "--bbb",
    "Content-Type: message/delivery-status",
    "",
    "Reporting-MTA: dns; googlemail.com",
    "",
    `Final-Recipient: rfc822; ${recipient}`,
    "Action: failed",
    `Status: ${status}`,
    `Diagnostic-Code: smtp; 550 ${status} address problem`,
    "",
    "--bbb",
    "Content-Type: message/rfc822",
    "",
    `Message-ID: ${original}`,
    `To: ${recipient}`,
    "",
    "--bbb--",
    "",
  ].join("\r\n");

const replyFrom = ({ from, inReplyTo, headers = [], id = randomBytes(4).toString("hex"), subject = "Re: Application" }) =>
  [`From: ${from}`, "To: system@mailflow.test", `Subject: ${subject}`, `Message-ID: <reply-${id}@example.org>`, ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`] : []), ...headers, "Date: Wed, 04 Nov 2026 12:00:00 +0000", "Content-Type: text/plain", "", "Thanks for writing.", ""].join("\r\n");

const SYSTEM_ACCOUNT = { key: "system", userId: null, accountId: null, label: "system@mailflow.test" };

before(async () => {
  await connectDB();
  await mongoose.connection.db.dropDatabase();
  await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));
  server = createApp().listen(0);
  url = `http://127.0.0.1:${server.address().port}`;
  const a = await alice("POST", "/mailflow/auth/register", { name: "Alice Doe", email: "alice@example.com", password: "password123" });
  aliceId = a.user.id;
  await bob("POST", "/mailflow/auth/register", { name: "Bob", email: "bob@example.com", password: "password123" });
  template = (await alice("GET", "/mailflow/templates")).templates[0];
});

after(async () => {
  await mongoose.connection.db.dropDatabase();
  server.closeAllConnections?.();
  server.close();
  await disconnectDB();
  fs.rmSync(storageDir, { recursive: true, force: true });
});

// ---------- status rules ----------

describe("status rules", () => {
  test("a temporary problem never restricts a contact permanently", () => {
    assert.equal(computeContactStatus({ bounceStatus: "Temporary" }), "Temporarily Rejected");
    assert.equal(sendRestriction({ bounceStatus: "Temporary" }), null);
  });
  test("hard bounce, invalid, unsubscribed and blocked all stop sending", () => {
    for (const c of [{ bounceStatus: "Hard" }, { emailValidity: "Invalid" }, { unsubscribed: true }, { isBlocked: true }]) {
      assert.equal(sendRestriction(c).selectable, false);
    }
  });
  test("soft bounces wait, then need review after the limit", () => {
    const later = new Date(Date.now() + 3600e3);
    assert.equal(sendRestriction({ bounceStatus: "Soft", softBounceCount: 1, softBounceRetryAt: later }).code, "soft_cooldown");
    assert.equal(sendRestriction({ bounceStatus: "Soft", softBounceCount: 1, softBounceRetryAt: new Date(Date.now() - 1000) }), null);
    assert.equal(sendRestriction({ bounceStatus: "Soft", softBounceCount: 3 }).code, "soft_limit");
  });
  test("an expired block doesn't count", () => {
    assert.equal(computeContactStatus({ isBlocked: true, blockedUntil: new Date(Date.now() - 1000) }), "Unknown");
  });
  test("SMTP failures: only address problems are about the contact", () => {
    assert.equal(classifySmtpFailure({ responseCode: 550, response: "550 5.1.1 no such user" }).kind, "hard");
    assert.equal(classifySmtpFailure({ responseCode: 550, response: "550 5.7.1 policy" }).kind, "rejected");
    assert.equal(classifySmtpFailure({ responseCode: 451, response: "451 4.3.0" }).kind, "temporary");
    assert.equal(classifySmtpFailure({ responseCode: 421 }).kind, "sender");
    assert.equal(classifySmtpFailure({ code: "EAUTH" }).kind, "auth");
    assert.equal(classifySmtpFailure({ code: "ECONNECTION" }).kind, "network");
    assert.equal(classifySmtpFailure({ responseCode: 552 }).kind, "message");
  });
});

// ---------- templates ----------

describe("template rendering", () => {
  const contact = { name: "Rahul", company: "Google", title: "", email: "r@g.com", category: "HR" };
  const sender = { senderName: "Khushant", senderEmail: "k@x.com", signature: "-- K", currentDate: "04 November 2026" };

  test("contact and sender variables, fallback, missing values, unknown left alone", () => {
    assert.equal(
      renderTemplate("Hello {{name}} at {{company}} [{{title}}] {{title|friend}} from {{senderName}} <{{senderEmail}}> on {{currentDate}} {{unknown}}", contact, sender),
      "Hello Rahul at Google [] friend from Khushant <k@x.com> on 04 November 2026 {{unknown}}",
    );
    assert.equal(renderTemplate("{{name|there}}", { name: "  " }), "there");
  });
  test("signature appended once, or placed where the template says", () => {
    assert.equal(composeEmail({ subject: "Hi", body: "Body" }, contact, sender).body, "Body\n\n-- K");
    assert.equal(composeEmail({ subject: "Hi", body: "A\n{{signature}}\nB" }, contact, sender).body, "A\n-- K\nB");
  });
  test("variables are inserted at the cursor, replacing a selection", () => {
    assert.deepEqual(insertAtCursor("Hello !", 6, 6, "{{name}}"), { value: "Hello {{name}}!", cursor: 14 });
    assert.deepEqual(insertAtCursor("Hello XX!", 6, 8, "{{name}}"), { value: "Hello {{name}}!", cursor: 14 });
    assert.equal(insertAtCursor("abc", undefined, undefined, "!").value, "abc!");
  });
  test("default resume: own only, removable, cleared when the resume is deleted, optional at send", async () => {
    const form = new FormData();
    form.append("files", new Blob([Buffer.from("%PDF-1.4\n%%EOF\n")]), "Default.pdf");
    const resume = (await alice("POST", "/mailflow/resumes/upload", form)).uploaded[0];

    const bobForm = new FormData();
    bobForm.append("files", new Blob([Buffer.from("%PDF-1.4\nbob\n%%EOF\n")]), "Bob.pdf");
    const bobResume = (await bob("POST", "/mailflow/resumes/upload", bobForm)).uploaded[0];

    const made = await alice("POST", "/mailflow/templates", { name: "With resume", subject: "S", body: "B", defaultResumeId: resume.id });
    assert.equal(made.status, 201);
    assert.equal(made.template.defaultResumeId, resume.id);
    assert.equal((await alice("POST", "/mailflow/templates", { name: "x", subject: "S", body: "B", defaultResumeId: bobResume.id })).status, 404);
    assert.equal((await alice("PUT", `/mailflow/templates/${made.template.id}`, { defaultResumeId: bobResume.id })).status, 404);
    assert.equal((await alice("PUT", `/mailflow/templates/${made.template.id}`, { defaultResumeId: null })).template.defaultResumeId, null);

    await alice("PUT", `/mailflow/templates/${made.template.id}`, { defaultResumeId: resume.id });
    assert.equal((await alice("DELETE", `/mailflow/resumes/${resume.id}`)).status, 200);
    const list = (await alice("GET", "/mailflow/templates")).templates;
    assert.equal(list.find((t) => t.id === made.template.id).defaultResumeId, null);
    await alice("DELETE", `/mailflow/templates/${made.template.id}`);
  });
});

// ---------- contacts ----------

describe("contact email correction, notes, follow-ups", () => {
  let contact;
  before(async () => {
    contact = await addContact("carears@company.com", { name: "HR" });
  });

  test("check-email reports syntax, duplicates and spelling without changing anything", async () => {
    await addContact("taken@company.com");
    const typo = await alice("GET", `/mailflow/contacts/check-email?email=carears@company.com&excludeId=${contact.id}`);
    assert.equal(typo.valid, true);
    assert.equal(typo.duplicate, null);
    assert.equal(typo.suggestions[0].suggestion, "careers@company.com");
    assert.equal((await alice("GET", "/mailflow/contacts/check-email?email=nope")).valid, false);
    assert.equal((await alice("GET", "/mailflow/contacts/check-email?email=taken@company.com")).duplicate.email, "taken@company.com");
    assert.equal((await getContact(contact.id)).email, "carears@company.com");
  });

  test("changing an address needs confirmation, refuses duplicates, keeps history and resets status", async () => {
    await send([contact.id]);
    await Contact.updateOne({ _id: contact.id }, { bounceStatus: "Hard", emailValidity: "Invalid", contactStatus: "Hard Bounced" });
    assert.equal((await alice("PATCH", `/mailflow/contacts/${contact.id}/email`, { email: "careers@company.com" })).status, 400);
    assert.equal((await alice("PATCH", `/mailflow/contacts/${contact.id}/email`, { email: "bad", confirm: true })).status, 400);
    assert.equal((await alice("PATCH", `/mailflow/contacts/${contact.id}/email`, { email: "taken@company.com", confirm: true })).status, 409);
    assert.equal((await bob("PATCH", `/mailflow/contacts/${contact.id}/email`, { email: "x@y.com", confirm: true })).status, 404);

    const r = await alice("PATCH", `/mailflow/contacts/${contact.id}/email`, { email: "careers@company.com", confirm: true });
    assert.equal(r.contact.email, "careers@company.com");
    assert.equal(r.contact.contactStatus, "Unknown");
    assert.equal(r.contact.addressHistory[0].email, "carears@company.com");
    assert.equal(r.contact.addressHistory[0].status, "Hard Bounced");
    const h = await alice("GET", `/mailflow/contacts/${contact.id}/email-history`);
    assert.equal(h.history[0].recipient, "carears@company.com");
    assert.ok(h.history[0].templateName);
    const a = await alice("GET", `/mailflow/contacts/${contact.id}/activity`);
    assert.ok(a.activities.some((x) => x.activityType === "email_changed" && /carears/.test(x.description)));
  });

  test("the edit form's email field keeps history too", async () => {
    const c = await addContact("edit-me@company.com");
    const r = await alice("PUT", `/mailflow/contacts/${c.id}`, { email: "edited@company.com" });
    assert.equal(r.contact.addressHistory[0].email, "edit-me@company.com");
  });

  test("notes: add, edit with versions, delete, timestamps, summary stays in step", async () => {
    const add = await alice("POST", `/mailflow/contacts/${contact.id}/notes`, { text: "HR requested portal application" });
    assert.equal(add.status, 201);
    assert.ok(add.note.createdAt);
    assert.equal(add.contact.notes, "HR requested portal application");
    const first = add.contact.noteUpdatedAt;

    await new Promise((r) => setTimeout(r, 15));
    const edit = await alice("PUT", `/mailflow/contacts/${contact.id}/notes/${add.note.id}`, { text: "Applied through the portal" });
    assert.equal(edit.note.versions[0].text, "HR requested portal application");
    assert.ok(new Date(edit.contact.noteUpdatedAt) > new Date(first));

    const second = await alice("POST", `/mailflow/contacts/${contact.id}/notes`, { text: "Second note" });
    assert.equal((await alice("GET", `/mailflow/contacts/${contact.id}/notes`)).notes.length, 2);
    const del = await alice("DELETE", `/mailflow/contacts/${contact.id}/notes/${second.note.id}`);
    assert.equal(del.contact.notes, "Applied through the portal");
    assert.equal((await alice("GET", `/mailflow/contacts/${contact.id}/notes`)).notes.length, 1);

    assert.equal((await bob("GET", `/mailflow/contacts/${contact.id}/notes`)).status, 404);
    assert.equal((await bob("PUT", `/mailflow/contacts/${contact.id}/notes/${add.note.id}`, { text: "x" })).status, 404);
    assert.equal((await alice("POST", `/mailflow/contacts/${contact.id}/notes`, { text: "  " })).status, 400);
  });

  test("older single notes field becomes the first note, keeping its time", async () => {
    const c = await addContact("legacy@company.com", { notes: "Old note" });
    await Contact.updateOne({ _id: c.id }, { noteUpdatedAt: new Date("2026-01-02T03:04:05Z") }, { timestamps: false });
    const { notes } = await alice("GET", `/mailflow/contacts/${c.id}/notes`);
    assert.equal(notes.length, 1);
    assert.equal(notes[0].text, "Old note");
    assert.equal(new Date(notes[0].updatedAt).toISOString(), "2026-01-02T03:04:05.000Z");
    assert.equal((await alice("GET", `/mailflow/contacts/${c.id}/notes`)).notes.length, 1);
  });

  test("follow-ups: next date, completion, cancellation, upcoming list", async () => {
    const soon = new Date(Date.now() + 86400e3).toISOString();
    const later = new Date(Date.now() + 3 * 86400e3).toISOString();
    assert.equal((await alice("POST", `/mailflow/contacts/${contact.id}/follow-ups`, { dueAt: new Date(Date.now() - 86400e3).toISOString() })).status, 400);
    const a = await alice("POST", `/mailflow/contacts/${contact.id}/follow-ups`, { dueAt: later, note: "Call" });
    const b = await alice("POST", `/mailflow/contacts/${contact.id}/follow-ups`, { dueAt: soon });
    assert.equal(new Date(b.contact.nextFollowUpAt).toISOString(), soon);

    const up = await alice("GET", "/mailflow/contacts/follow-ups/upcoming");
    assert.equal(up.followUps[0].contact.email, "careers@company.com");
    assert.equal((await bob("GET", "/mailflow/contacts/follow-ups/upcoming")).followUps.length, 0);

    const done = await alice("PATCH", `/mailflow/contacts/${contact.id}/follow-ups/${b.followUp.id}`, { status: "Done" });
    assert.ok(done.contact.lastFollowUpAt);
    assert.equal(new Date(done.contact.nextFollowUpAt).toISOString(), later);
    const cancelled = await alice("PATCH", `/mailflow/contacts/${contact.id}/follow-ups/${a.followUp.id}`, { status: "Cancelled" });
    assert.equal(cancelled.contact.nextFollowUpAt, null);
    assert.equal((await bob("PATCH", `/mailflow/contacts/${contact.id}/follow-ups/${a.followUp.id}`, { status: "Done" })).status, 404);
    const types = (await alice("GET", `/mailflow/contacts/${contact.id}/activity`)).activities.map((x) => x.activityType);
    for (const t of ["followup_added", "followup_done", "followup_cancelled", "note_added", "note_edited", "note_deleted"]) assert.ok(types.includes(t), t);
  });

  test("manual status correction needs confirmation and is logged; blocking keeps its own route", async () => {
    assert.equal((await alice("PATCH", `/mailflow/contacts/${contact.id}/status`, { status: "Invalid" })).status, 400);
    assert.equal((await alice("PATCH", `/mailflow/contacts/${contact.id}/status`, { status: "Blocked", confirm: true })).status, 400);
    const r = await alice("PATCH", `/mailflow/contacts/${contact.id}/status`, { status: "Invalid", confirm: true, reason: "Told by phone" });
    assert.equal(r.contact.contactStatus, "Invalid");
    const back = await alice("PATCH", `/mailflow/contacts/${contact.id}/status`, { status: "Valid", confirm: true });
    assert.equal(back.contact.contactStatus, "Valid");
    const a = (await alice("GET", `/mailflow/contacts/${contact.id}/activity`)).activities.find((x) => x.activityType === "status_changed");
    assert.match(a.description, /Invalid to Valid/);
    assert.equal(a.metadata.manual, true);
    assert.equal((await bob("PATCH", `/mailflow/contacts/${contact.id}/status`, { status: "Valid", confirm: true })).status, 404);
  });

  test("older contacts get counters and a timeline from EmailHistory exactly once", async () => {
    const c = await Contact.create({ userId: aliceId, serialNo: 9000, email: "old@company.com", intelVersion: 0 });
    await EmailHistory.create([
      { userId: aliceId, contactId: c._id, recipient: c.email, subject: "One", status: "Sent", sentAt: new Date("2026-01-01") },
      { userId: aliceId, contactId: c._id, recipient: c.email, subject: "Two", status: "Failed", errorMessage: "x", sentAt: new Date("2026-01-02") },
      { userId: aliceId, contactId: c._id, recipient: c.email, subject: "Dry", status: "Sent", dryRun: true, sentAt: new Date("2026-01-03") },
    ]);
    assert.ok((await backfillContactIntel()) >= 1);
    const fresh = await Contact.findById(c._id);
    assert.deepEqual([fresh.totalEmailsSent, fresh.acceptedCount, fresh.failedCount], [2, 1, 1]);
    assert.equal(await ContactActivity.countDocuments({ contactId: c._id }), 2);
    assert.equal(await backfillContactIntel(), 0);
    assert.equal((await Contact.findById(c._id)).totalEmailsSent, 2);
    await Contact.deleteOne({ _id: c._id });
    await EmailHistory.deleteMany({ contactId: c._id });
  });
});

// ---------- campaigns ----------

describe("live campaigns", () => {
  test("recipients go through; accepted is recorded per recipient and never called delivered", async () => {
    await clearDuplicateWindow();
    const a = await addContact("one@acme.io", { company: "Acme" });
    const b = await addContact("two@acme.io");
    const r = await send([a.id, b.id, a.id]);
    assert.equal(r.campaign.status, "Completed");
    assert.equal(r.campaign.totalRecipients, 2);
    assert.equal(r.campaign.acceptedCount, 2);
    assert.equal(r.campaign.remaining, 0);
    assert.deepEqual(r.recipients.map((x) => x.status), ["Accepted", "Accepted"]);
    assert.equal(r.recipients[0].company, "Acme");
    assert.ok(r.recipients[0].messageId);

    const c = await getContact(a.id);
    assert.equal(c.deliveryStatus, "Accepted");
    assert.equal(c.lastEmailStatus, "Accepted");
    assert.equal(c.emailValidity, "Unknown"); // acceptance proves nothing
    assert.equal(c.contactStatus, "Unknown");
    assert.deepEqual([c.totalEmailsSent, c.acceptedCount, c.failedCount], [1, 1, 0]);
    const h = await alice("GET", `/mailflow/contacts/${a.id}/email-history`);
    assert.equal(h.history[0].source, "campaign");
    assert.equal(h.history[0].campaignId, r.campaign.id);
  });

  test("SSE: snapshot, each status change, then done; closing the stream doesn't stop sending", async () => {
    await clearDuplicateWindow();
    let release;
    const gate = new Promise((res) => (release = res));
    setTransporter({
      sendMail: async (msg) => {
        await gate;
        return respond(msg, "system");
      },
    });
    const contacts = [await addContact("sse1@acme.io"), await addContact("sse2@acme.io")];
    const started = await alice("POST", "/mailflow/campaigns", { templateId: template.id, contactIds: contacts.map((c) => c.id) });

    const res = await alice("GET", `/mailflow/campaigns/${started.campaign.id}/events`, null, { raw: true });
    assert.match(res.headers.get("content-type"), /text\/event-stream/);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const seen = [];
    let released = false;
    const statuses = new Set();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let i;
      while ((i = buffer.indexOf("\n\n")) >= 0) {
        const chunk = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        const event = chunk.match(/^event: (.+)$/m)?.[1];
        const data = chunk.match(/^data: (.+)$/m)?.[1];
        if (!event) continue;
        seen.push(event);
        for (const r of JSON.parse(data).recipients ?? []) statuses.add(r.status);
      }
      if (!released && statuses.has("Sending")) {
        released = true;
        release();
      }
    }
    assert.equal(seen[0], "snapshot");
    assert.equal(seen.at(-1), "done");
    assert.ok(statuses.has("Sending"));
    assert.ok(statuses.has("Accepted"));

    // A second campaign: disconnect immediately, it still finishes.
    setTransporter({ sendMail: async (msg) => respond(msg, "system"), verify: async () => true });
    await clearDuplicateWindow();
    const next = await alice("POST", "/mailflow/campaigns", { templateId: template.id, contactIds: [contacts[0].id] });
    const ac = new AbortController();
    await fetch(`${url}/mailflow/campaigns/${next.campaign.id}/events`, { signal: ac.signal, headers: { cookie: "" } }).catch(() => {});
    ac.abort();
    assert.equal((await waitForCampaign(alice, next.campaign.id)).campaign.status, "Completed");
  });

  test("progress comes back after a refresh from /active, and only for its owner", async () => {
    await clearDuplicateWindow();
    let release;
    const gate = new Promise((res) => (release = res));
    setTransporter({
      sendMail: async (msg) => {
        await gate;
        return respond(msg, "system");
      },
    });
    const c = await addContact("refresh@acme.io");
    const started = await alice("POST", "/mailflow/campaigns", { templateId: template.id, contactIds: [c.id] });
    const active = await alice("GET", "/mailflow/campaigns/active");
    assert.equal(active.campaign.id, started.campaign.id);
    assert.equal(active.recipients.length, 1);
    assert.equal((await bob("GET", "/mailflow/campaigns/active")).campaign, null);
    assert.equal((await bob("GET", `/mailflow/campaigns/${started.campaign.id}/progress`)).status, 404);
    assert.equal((await bob("GET", `/mailflow/campaigns/${started.campaign.id}/events`)).status, 404);

    // One at a time per user.
    const second = await alice("POST", "/mailflow/campaigns", { templateId: template.id, contactIds: [c.id] });
    assert.equal(second.status, 409);
    assert.equal(second.details[0].message, started.campaign.id);

    release();
    await waitForCampaign(alice, started.campaign.id);
    setTransporter({ sendMail: async (msg) => respond(msg, "system"), verify: async () => true });
    assert.equal((await alice("GET", "/mailflow/campaigns/active")).campaign, null);
  });

  test("the same request id creates one campaign", async () => {
    await clearDuplicateWindow();
    const c = await addContact("idem@acme.io");
    const before = outbox.length;
    const body = { templateId: template.id, contactIds: [c.id], clientRequestId: "request-12345" };
    const first = await alice("POST", "/mailflow/campaigns", body);
    await waitForCampaign(alice, first.campaign.id);
    const again = await alice("POST", "/mailflow/campaigns", body);
    assert.equal(again.status, 200);
    assert.equal(again.campaign.id, first.campaign.id);
    assert.equal(outbox.length, before + 1);
  });

  test("failures show the real error; hard failures flag the address, temporary and our-side ones don't", async () => {
    await clearDuplicateWindow();
    const hard = await addContact("hard@acme.io");
    const temp = await addContact("temp@acme.io");
    const policy = await addContact("policy@acme.io");
    const net = await addContact("network@acme.io");
    const r = await send([hard.id, temp.id, policy.id, net.id]);
    const by = Object.fromEntries(r.recipients.map((x) => [x.recipientEmail, x]));
    assert.equal(r.campaign.failedCount, 4);
    assert.match(by["hard@acme.io"].errorMessage, /5\.1\.1/);
    assert.equal(by["hard@acme.io"].retryable, false);
    assert.equal(by["temp@acme.io"].retryable, true);
    assert.equal(by["policy@acme.io"].retryable, false);
    assert.equal(by["network@acme.io"].retryable, true);

    assert.equal((await getContact(hard.id)).contactStatus, "Hard Bounced");
    assert.equal((await getContact(temp.id)).contactStatus, "Temporarily Rejected");
    assert.equal((await getContact(policy.id)).contactStatus, "Bounced");
    assert.equal((await getContact(net.id)).contactStatus, "Unknown");
    const a = (await alice("GET", `/mailflow/contacts/${hard.id}/activity`)).activities.map((x) => x.activityType);
    assert.ok(a.includes("email_failed") && a.includes("marked_invalid"));
  });

  test("retry resends only eligible failures, never accepted recipients", async () => {
    await clearDuplicateWindow();
    const ok = await addContact("retry-ok@acme.io");
    const temp = await addContact("temp-retry@acme.io");
    const hard = await addContact("hard-retry@acme.io");
    const r = await send([ok.id, temp.id, hard.id]);
    assert.equal(r.campaign.acceptedCount, 1);

    await Contact.updateOne({ _id: temp.id }, { email: "fixed-retry@acme.io" }); // the temp address now works
    const before = outbox.filter((m) => m.to === "retry-ok@acme.io").length;
    const retried = await alice("POST", `/mailflow/campaigns/${r.campaign.id}/retry`);
    assert.equal(retried.status, 202);
    assert.equal(retried.retried, 1);
    const done = await waitForCampaign(alice, r.campaign.id);
    assert.equal(done.campaign.acceptedCount, 2);
    assert.equal(done.campaign.failedCount, 1);
    assert.equal(done.campaign.processedCount, 3);
    assert.equal(outbox.filter((m) => m.to === "retry-ok@acme.io").length, before);
    assert.equal((await alice("POST", `/mailflow/campaigns/${r.campaign.id}/retry`)).status, 400);
    assert.equal((await bob("POST", `/mailflow/campaigns/${r.campaign.id}/retry`)).status, 404);
  });

  test("restricted contacts and repeats are skipped with the reason, nothing is sent to them", async () => {
    await clearDuplicateWindow();
    const blocked = await addContact("skip-blocked@acme.io");
    await alice("PATCH", `/mailflow/contacts/${blocked.id}/block`, { blocked: true, reason: "Asked to stop" });
    const hard = await addContact("skip-hard@acme.io");
    await alice("PATCH", `/mailflow/contacts/${hard.id}/status`, { status: "Hard Bounced", confirm: true });
    const unsub = await addContact("skip-unsub@acme.io");
    await alice("PATCH", `/mailflow/contacts/${unsub.id}/status`, { status: "Unsubscribed", confirm: true });
    const fine = await addContact("skip-fine@acme.io");
    const before = outbox.length;
    const r = await send([blocked.id, hard.id, unsub.id, fine.id]);
    assert.equal(r.campaign.skippedCount, 3);
    assert.equal(r.campaign.acceptedCount, 1);
    assert.equal(outbox.length, before + 1);
    assert.match(r.recipients[0].errorMessage, /Blocked until you unblock: Asked to stop/);
    assert.match(r.recipients[1].errorMessage, /Hard bounced/);
    assert.match(r.recipients[2].errorMessage, /Unsubscribed/);

    const repeat = await send([fine.id]);
    assert.equal(repeat.campaign.skippedCount, 1);
    assert.match(repeat.recipients[0].errorMessage, /last 10 minutes/);

    // The older endpoint and scheduling follow the same rules.
    const legacy = await alice("POST", "/mailflow/emails/send", { templateId: template.id, contactIds: [hard.id] });
    assert.equal(legacy.skipped, 1);
    const sched = await alice("POST", "/mailflow/schedules", { templateId: template.id, contactIds: [hard.id], scheduledAt: new Date(Date.now() + 3600e3).toISOString() });
    assert.equal(sched.status, 400);
    assert.match(sched.message, /Hard bounced/);
  });

  test("cancel stops what hasn't started", async () => {
    await clearDuplicateWindow();
    let release;
    const gate = new Promise((res) => (release = res));
    setTransporter({
      sendMail: async (msg) => {
        await gate;
        return respond(msg, "system");
      },
    });
    const list = [await addContact("c1@acme.io"), await addContact("c2@acme.io"), await addContact("c3@acme.io")];
    const started = await alice("POST", "/mailflow/campaigns", { templateId: template.id, contactIds: list.map((c) => c.id) });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal((await bob("POST", `/mailflow/campaigns/${started.campaign.id}/cancel`)).status, 404);
    assert.equal((await alice("POST", `/mailflow/campaigns/${started.campaign.id}/cancel`)).status, 200);
    release();
    const r = await waitForCampaign(alice, started.campaign.id);
    setTransporter({ sendMail: async (msg) => respond(msg, "system"), verify: async () => true });
    assert.equal(r.campaign.status, "Cancelled");
    assert.equal(r.recipients.filter((x) => x.status === "Accepted").length, 1);
    assert.equal(r.recipients.filter((x) => x.status === "Cancelled").length, 2);
  });

  test("crash recovery: waiting recipients continue, an interrupted one isn't re-sent automatically", async () => {
    await clearDuplicateWindow();
    const list = [await addContact("crash1@acme.io"), await addContact("crash2@acme.io"), await addContact("crash3@acme.io")];
    const campaign = await EmailCampaign.create({
      userId: aliceId,
      templateId: template.id,
      totalRecipients: 3,
      status: "Running",
      lockedBy: "dead-worker",
      heartbeatAt: new Date(Date.now() - 3600e3),
      processedCount: 1,
      acceptedCount: 1,
    });
    await EmailCampaignRecipient.insertMany([
      { campaignId: campaign._id, userId: aliceId, contactId: list[0].id, position: 0, recipientEmail: list[0].email, status: "Accepted" },
      { campaignId: campaign._id, userId: aliceId, contactId: list[1].id, position: 1, recipientEmail: list[1].email, status: "Sending" },
      { campaignId: campaign._id, userId: aliceId, contactId: list[2].id, position: 2, recipientEmail: list[2].email, status: "Waiting" },
    ]);
    const before = outbox.length;
    const started = [];
    const n = await recoverCampaigns({ start: (id) => started.push(id) });
    assert.equal(n, 1);
    await runCampaign(started[0], { delayMs: 0 });

    const r = await alice("GET", `/mailflow/campaigns/${campaign._id}/progress`);
    assert.equal(r.campaign.status, "Completed");
    assert.deepEqual(r.recipients.map((x) => x.status), ["Accepted", "Failed", "Accepted"]);
    assert.match(r.recipients[1].errorMessage, /Interrupted/);
    assert.equal(r.recipients[1].retryable, true);
    assert.equal(outbox.length, before + 1);
    assert.equal(outbox.at(-1).to, "crash3@acme.io");
    assert.equal(await recoverCampaigns({ start: () => {} }), 0);
  });

  test("two workers can't run the same campaign", async () => {
    await clearDuplicateWindow();
    const c = await addContact("race@acme.io");
    const campaign = await EmailCampaign.create({ userId: aliceId, templateId: template.id, totalRecipients: 1 });
    await EmailCampaignRecipient.create({ campaignId: campaign._id, userId: aliceId, contactId: c.id, position: 0, recipientEmail: c.email });
    const before = outbox.length;
    const results = await Promise.all([runCampaign(campaign._id, { delayMs: 0 }), runCampaign(campaign._id, { delayMs: 0 })]);
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(outbox.length, before + 1);
  });
});

// ---------- sender accounts ----------

const accountBody = (extra = {}) => ({
  label: "Work",
  senderName: "Alice at Work",
  senderEmail: "alice@work.example",
  smtpHost: "smtp.work.example",
  smtpPort: 465,
  smtpSecurity: "ssl",
  smtpUsername: "alice@work.example",
  password: "super-secret-app-password",
  replyTo: "reply@work.example",
  ...extra,
});

describe("sender accounts", () => {
  let account;

  test("encryption: round trip, random per value, tamper and wrong key fail", () => {
    const a = encryptSecret("pw");
    assert.notEqual(a, encryptSecret("pw"));
    assert.ok(!a.includes("pw"));
    assert.equal(decryptSecret(a), "pw");
    const parts = a.split(".");
    parts[3] = Buffer.from("other").toString("base64url");
    assert.throws(() => decryptSecret(parts.join(".")));
    assert.throws(() => decryptSecret(a, randomBytes(32)));
  });

  test("private network hosts are recognised", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.1.1", "172.20.0.1", "169.254.169.254", "::1", "fd00::1", "::ffff:127.0.0.1"]) assert.equal(isPrivateAddress(ip), true, ip);
    for (const ip of ["8.8.8.8", "142.250.1.1", "2607:f8b0::1"]) assert.equal(isPrivateAddress(ip), false, ip);
  });

  test("validation", async () => {
    for (const bad of [{ smtpHost: "not a host" }, { smtpPort: 8080 }, { smtpPort: 587 }, { senderEmail: "nope" }, { password: "" }, { imapEnabled: true }]) {
      assert.equal((await alice("POST", "/mailflow/email-accounts", accountBody(bad))).status, 400, JSON.stringify(bad));
    }
    assert.equal((await alice("POST", "/mailflow/email-accounts", accountBody({ smtpPort: 465, smtpSecurity: "starttls" }))).status, 400);
    assert.equal((await alice("POST", "/mailflow/email-accounts", accountBody({ smtpPort: 2525, smtpSecurity: "starttls", senderEmail: "port@work.example" }))).status, 201);
    await EmailAccount.deleteMany({ senderEmail: "port@work.example" });
  });

  test("the password is encrypted at rest and never comes back", async () => {
    const r = await alice("POST", "/mailflow/email-accounts", accountBody());
    assert.equal(r.status, 201);
    account = r.account;
    assert.equal(account.isDefault, true);
    assert.equal(account.hasPassword, true);
    const everyResponse = JSON.stringify([r, await alice("GET", "/mailflow/email-accounts")]);
    assert.ok(!everyResponse.includes("super-secret"));
    assert.ok(!everyResponse.includes("passwordEncrypted"));

    const stored = await EmailAccount.findById(account.id).select("+passwordEncrypted");
    assert.ok(!stored.passwordEncrypted.includes("super-secret"));
    assert.equal(decryptSecret(stored.passwordEncrypted), "super-secret-app-password");

    const list = await alice("GET", "/mailflow/email-accounts");
    assert.equal(list.sendingMode, "system");
    assert.equal(list.system.senderEmail, "system@mailflow.test");
    assert.ok(!JSON.stringify(list.system).includes("not-a-real-password"));
  });

  test("another user can't see, change, use or test it", async () => {
    assert.equal((await bob("GET", "/mailflow/email-accounts")).accounts.length, 0);
    assert.equal((await bob("PUT", `/mailflow/email-accounts/${account.id}`, { label: "x" })).status, 404);
    assert.equal((await bob("DELETE", `/mailflow/email-accounts/${account.id}`)).status, 404);
    assert.equal((await bob("POST", `/mailflow/email-accounts/${account.id}/test`)).status, 404);
    assert.equal((await bob("POST", `/mailflow/email-accounts/${account.id}/test-send`)).status, 404);
    assert.equal((await bob("POST", `/mailflow/email-accounts/${account.id}/default`)).status, 404);
    const t = (await bob("GET", "/mailflow/templates")).templates[0];
    const c = (await bob("POST", "/mailflow/contacts", { email: "x@bob.example" })).contact;
    assert.equal((await bob("POST", "/mailflow/campaigns", { templateId: t.id, contactIds: [c.id], emailAccountId: account.id })).status, 404);
  });

  test("system mode uses the server account; choosing an account or custom mode uses that account", async () => {
    await clearDuplicateWindow();
    const c = await addContact("mode@acme.io");

    await send([c.id]);
    assert.equal(outbox.at(-1).via, "system");
    assert.match(outbox.at(-1).from, /system@mailflow\.test/);

    await clearDuplicateWindow();
    await send([c.id], { emailAccountId: account.id });
    assert.equal(outbox.at(-1).via, "alice@work.example");
    assert.match(outbox.at(-1).from, /"Alice at Work" <alice@work\.example>/);
    assert.equal(outbox.at(-1).replyTo, "reply@work.example");
    assert.equal(customTransportsCreated.at(-1).password, "super-secret-app-password");

    await alice("PUT", "/mailflow/settings", { settings: { sendingMode: "custom" } });
    await clearDuplicateWindow();
    await send([c.id]);
    assert.equal(outbox.at(-1).via, "alice@work.example");
    const h = await alice("GET", `/mailflow/contacts/${c.id}/email-history`);
    assert.equal(h.history[0].senderEmail, "alice@work.example");
    assert.equal(h.history[0].emailAccountId, account.id);

    await clearDuplicateWindow();
    await send([c.id], { emailAccountId: "system" });
    assert.equal(outbox.at(-1).via, "system");
    await alice("PUT", "/mailflow/settings", { settings: { sendingMode: "system" } });
  });

  test("a broken custom account fails clearly and never falls back to the system account", async () => {
    await clearDuplicateWindow();
    const c = await addContact("nofallback@acme.io");
    customBehaviour.authFails = true;
    const before = outbox.length;
    const r = await send([c.id], { emailAccountId: account.id });
    customBehaviour = {};
    assert.equal(r.campaign.failedCount, 1);
    assert.match(r.recipients[0].errorMessage, /rejected the login/);
    assert.equal(r.recipients[0].retryable, true);
    assert.equal(outbox.length, before);
    assert.equal((await getContact(c.id)).contactStatus, "Unknown"); // our login problem, not the contact's

    // Undecryptable password: refused up front.
    await EmailAccount.updateOne({ _id: account.id }, { passwordEncrypted: encryptSecret("x", randomBytes(32)) });
    const refused = await alice("POST", "/mailflow/campaigns", { templateId: template.id, contactIds: [c.id], emailAccountId: account.id });
    assert.equal(refused.status, 500);
    assert.match(refused.message, /can't be read/);
    await EmailAccount.updateOne({ _id: account.id }, { passwordEncrypted: encryptSecret("super-secret-app-password") });

    // Custom mode with no default: an error, not the system account.
    await EmailAccount.updateOne({ _id: account.id }, { isDefault: false });
    await alice("PUT", "/mailflow/settings", { settings: { sendingMode: "custom" } });
    const noDefault = await alice("POST", "/mailflow/campaigns", { templateId: template.id, contactIds: [c.id] });
    assert.equal(noDefault.status, 400);
    assert.match(noDefault.message, /no default account/);
    await alice("PUT", "/mailflow/settings", { settings: { sendingMode: "system" } });
    await EmailAccount.updateOne({ _id: account.id }, { isDefault: true });
  });

  test("test connection and test email report the outcome", async () => {
    const ok = await alice("POST", `/mailflow/email-accounts/${account.id}/test`);
    assert.equal(ok.status, 200);
    customBehaviour.authFails = true;
    const bad = await alice("POST", `/mailflow/email-accounts/${account.id}/test`);
    assert.equal(bad.status, 400);
    assert.match(bad.message, /rejected the login/);
    assert.equal((await alice("GET", "/mailflow/email-accounts")).accounts[0].lastTestOk, false);
    customBehaviour = {};

    const before = outbox.length;
    const sent = await alice("POST", `/mailflow/email-accounts/${account.id}/test-send`);
    assert.equal(sent.status, 200);
    assert.equal(outbox.length, before + 1);
    assert.equal(outbox.at(-1).to, "alice@example.com"); // only ever your own address
    assert.equal((await alice("POST", "/mailflow/email-accounts/system/test")).status, 200);
  });

  test("a saved password can't be pointed at another server without re-entering it", async () => {
    const r = await alice("PUT", `/mailflow/email-accounts/${account.id}`, { smtpHost: "evil.example.com" });
    assert.equal(r.status, 400);
    assert.match(r.message, /password again/);
    assert.equal((await alice("PUT", `/mailflow/email-accounts/${account.id}`, { smtpUsername: "someone@else.example" })).status, 400);
    const renamed = await alice("PUT", `/mailflow/email-accounts/${account.id}`, { label: "Renamed" });
    assert.equal(renamed.account.label, "Renamed");
    assert.ok(!JSON.stringify(renamed).includes("passwordEncrypted"));
    const moved = await alice("PUT", `/mailflow/email-accounts/${account.id}`, { smtpHost: "smtp2.work.example", password: "new-password" });
    assert.equal(moved.account.smtpHost, "smtp2.work.example");
    assert.equal(moved.account.lastTestOk, null);
  });

  test("several accounts; default moves; delete is refused while schedules use it", async () => {
    const second = (await alice("POST", "/mailflow/email-accounts", accountBody({ senderEmail: "second@work.example", smtpUsername: "second@work.example" }))).account;
    assert.equal(second.isDefault, false);
    const dup = await alice("POST", "/mailflow/email-accounts", accountBody({ senderEmail: "second@work.example", smtpUsername: "second@work.example" }));
    assert.equal(dup.status, 409);
    const made = await alice("POST", `/mailflow/email-accounts/${second.id}/default`);
    assert.equal(made.account.isDefault, true);
    assert.equal((await alice("GET", "/mailflow/email-accounts")).accounts.filter((a) => a.isDefault).length, 1);

    const c = await addContact("pinned@acme.io");
    const sched = await alice("POST", "/mailflow/schedules", { templateId: template.id, contactIds: [c.id], emailAccountId: second.id, scheduledAt: new Date(Date.now() + 3600e3).toISOString() });
    assert.equal(sched.status, 201);
    const del = await alice("DELETE", `/mailflow/email-accounts/${second.id}`);
    assert.equal(del.status, 409);
    assert.match(del.message, /scheduled email/);

    // The job goes out through the pinned account.
    await ScheduledEmail.updateOne({ _id: sched.schedules[0].id }, { scheduledAt: new Date(Date.now() - 1000) });
    assert.equal((await processDue({ delayMs: 0 })).Sent, 1);
    assert.equal(outbox.at(-1).via, "second@work.example");

    assert.equal((await alice("DELETE", `/mailflow/email-accounts/${second.id}`)).status, 200);
    assert.equal((await alice("GET", "/mailflow/email-accounts")).accounts.filter((a) => a.isDefault).length, 1);
  });

  test("a schedule whose account vanished fails instead of using another sender", async () => {
    const extra = (await alice("POST", "/mailflow/email-accounts", accountBody({ senderEmail: "gone@work.example", smtpUsername: "gone@work.example" }))).account;
    const c = await addContact("vanish@acme.io");
    const sched = await alice("POST", "/mailflow/schedules", { templateId: template.id, contactIds: [c.id], emailAccountId: extra.id, scheduledAt: new Date(Date.now() + 3600e3).toISOString() });
    await EmailAccount.deleteOne({ _id: extra.id }); // bypasses the API guard on purpose
    await ScheduledEmail.updateOne({ _id: sched.schedules[0].id }, { scheduledAt: new Date(Date.now() - 1000) });
    const before = outbox.length;
    assert.equal((await processDue({ delayMs: 0 })).Failed, 1);
    assert.equal(outbox.length, before);
    assert.match((await ScheduledEmail.findById(sched.schedules[0].id)).errorMessage, /Not sent: .*no longer exists/);
  });
});

// ---------- incoming mail ----------

describe("incoming mail", () => {
  /** Send to a contact and return the contact and the Message-ID used. */
  async function sendTo(email) {
    await clearDuplicateWindow();
    const c = await addContact(email);
    const r = await send([c.id]);
    return { contact: c, messageId: r.recipients[0].messageId };
  }

  test("a hard bounce is tied by Message-ID, flags the address, stops future sends, and is processed once", async () => {
    const { contact, messageId } = await sendTo("ghost@nowhere.example");
    const raw = bounceFor({ recipient: "ghost@nowhere.example", original: messageId, id: "hard1" });

    const r = await ingestRawMessage(SYSTEM_ACCOUNT, raw);
    assert.equal(r.stored, true);
    assert.equal(r.classification, "hard_bounce");

    const c = await getContact(contact.id);
    assert.equal(c.contactStatus, "Hard Bounced");
    assert.equal(c.emailValidity, "Invalid");
    assert.equal(c.deliveryStatus, "Bounced");
    assert.equal(c.hardBounceCount, 1);
    assert.match(c.bounceReason, /5\.1\.1/);

    const dup = await ingestRawMessage(SYSTEM_ACCOUNT, raw);
    assert.equal(dup.reason, "duplicate");
    assert.equal((await getContact(contact.id)).hardBounceCount, 1);

    const msgs = (await alice("GET", `/mailflow/contacts/${contact.id}/incoming`)).messages;
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].matchedBy, "original-message-id");
    assert.equal(msgs[0].bounce.status, "5.1.1");
    const hist = (await alice("GET", `/mailflow/contacts/${contact.id}/email-history`)).history[0];
    assert.equal(hist.outcome, "Hard bounced");
    assert.equal(hist.status, "Sent"); // it was accepted; what came back is separate

    const types = (await alice("GET", `/mailflow/contacts/${contact.id}/activity`)).activities.map((a) => a.activityType);
    assert.ok(types.includes("hard_bounce") && types.includes("marked_invalid"));

    const before = outbox.length;
    await clearDuplicateWindow();
    const again = await send([contact.id]);
    assert.equal(again.campaign.skippedCount, 1);
    assert.equal(outbox.length, before);
    const camp = await EmailCampaignRecipient.findOne({ contactId: contact.id, status: "Accepted" });
    assert.equal(camp.outcome, "Hard bounced");
  });

  test("a soft bounce isn't permanent: it waits, then can be retried; three in a row need review", async () => {
    const { contact, messageId } = await sendTo("full@mailbox.example");
    await ingestRawMessage(SYSTEM_ACCOUNT, bounceFor({ recipient: "full@mailbox.example", original: messageId, status: "5.2.2", id: "soft1" }));
    let c = await getContact(contact.id);
    assert.equal(c.contactStatus, "Soft Bounced");
    assert.equal(c.emailValidity, "Unknown");
    assert.ok(new Date(c.softBounceRetryAt) > new Date());

    await clearDuplicateWindow();
    const waiting = await send([contact.id]);
    assert.match(waiting.recipients[0].errorMessage, /retry after/);

    // A scheduled email waits it out rather than being cancelled.
    const later = new Date(Date.now() + 2 * 86400e3).toISOString();
    assert.equal((await alice("POST", "/mailflow/schedules", { templateId: template.id, contactIds: [contact.id], scheduledAt: later })).scheduled, 1);

    await Contact.updateOne({ _id: contact.id }, { softBounceRetryAt: new Date(Date.now() - 1000) });
    await clearDuplicateWindow();
    assert.equal((await send([contact.id])).campaign.acceptedCount, 1);

    await Contact.updateOne({ _id: contact.id }, { softBounceCount: 3, softBounceRetryAt: null });
    await clearDuplicateWindow();
    assert.match((await send([contact.id])).recipients[0].errorMessage, /3 soft bounces/);
  });

  test("temporary rejection and policy rejection don't mark the address invalid", async () => {
    const a = await sendTo("grey@list.example");
    await ingestRawMessage(SYSTEM_ACCOUNT, bounceFor({ recipient: "grey@list.example", original: a.messageId, status: "4.7.1", id: "t1" }));
    let c = await getContact(a.contact.id);
    assert.equal(c.contactStatus, "Temporarily Rejected");
    assert.equal(c.emailValidity, "Unknown");

    const b = await sendTo("spamfilter@corp.example");
    await ingestRawMessage(SYSTEM_ACCOUNT, bounceFor({ recipient: "spamfilter@corp.example", original: b.messageId, status: "5.7.1", id: "t2" }));
    c = await getContact(b.contact.id);
    assert.equal(c.contactStatus, "Bounced");
    assert.equal(c.emailValidity, "Unknown");
    assert.equal(sendRestriction(c), null);
  });

  test("a human reply via In-Reply-To; references also work; the mailbox is then valid", async () => {
    const { contact, messageId } = await sendTo("human@acme.example");
    const r = await ingestRawMessage(SYSTEM_ACCOUNT, replyFrom({ from: "Human <human@acme.example>", inReplyTo: messageId, id: "h1" }));
    assert.equal(r.classification, "human_reply");
    const c = await getContact(contact.id);
    assert.equal(c.contactStatus, "Replied");
    assert.equal(c.emailValidity, "Valid");
    assert.equal(c.replyCount, 1);
    assert.ok(c.lastRepliedAt && c.lastEmailReceivedAt);
    const hist = (await alice("GET", `/mailflow/contacts/${contact.id}/email-history`)).history[0];
    assert.equal(hist.outcome, "Replied");

    const refs = await sendTo("human2@acme.example");
    const r2 = await ingestRawMessage(SYSTEM_ACCOUNT, replyFrom({ from: "other-address@elsewhere.example", headers: [`References: <unknown@x> ${refs.messageId}`], id: "h2" }));
    assert.equal(r2.stored, true);
    assert.equal(String(r2.contactId), refs.contact.id); // the right contact even from another address
  });

  test("an automatic reply isn't a bounce and isn't a real reply", async () => {
    const { contact, messageId } = await sendTo("away@acme.example");
    const r = await ingestRawMessage(SYSTEM_ACCOUNT, replyFrom({ from: "away@acme.example", inReplyTo: messageId, headers: ["Auto-Submitted: auto-replied"], subject: "Out of office", id: "a1" }));
    assert.equal(r.classification, "out_of_office");
    const c = await getContact(contact.id);
    assert.equal(c.contactStatus, "Auto Replied");
    assert.equal(c.bounceStatus, "None");
    assert.equal(c.replyCount, 0);
    assert.equal(sendRestriction(c), null);

    // A later real reply wins; a later auto reply doesn't undo it.
    await ingestRawMessage(SYSTEM_ACCOUNT, replyFrom({ from: "away@acme.example", inReplyTo: messageId, id: "a2" }));
    await ingestRawMessage(SYSTEM_ACCOUNT, replyFrom({ from: "away@acme.example", inReplyTo: messageId, headers: ["Auto-Submitted: auto-replied"], id: "a3" }));
    assert.equal((await getContact(contact.id)).contactStatus, "Replied");
  });

  test("a bounce for the old address after a correction doesn't touch the new one", async () => {
    const { contact, messageId } = await sendTo("typoo@acme.example");
    await alice("PATCH", `/mailflow/contacts/${contact.id}/email`, { email: "typo@acme.example", confirm: true });
    const r = await ingestRawMessage(SYSTEM_ACCOUNT, bounceFor({ recipient: "typoo@acme.example", original: messageId, id: "old1" }));
    assert.equal(r.stored, true);
    const c = await getContact(contact.id);
    assert.equal(c.contactStatus, "Unknown");
    assert.equal(c.hardBounceCount, 0);
    const a = (await alice("GET", `/mailflow/contacts/${contact.id}/activity`)).activities.find((x) => x.activityType === "hard_bounce");
    assert.match(a.description, /old address typoo@acme\.example/);
  });

  test("unrelated inbox mail and our own copies are never stored", async () => {
    const before = await IncomingEmail.countDocuments();
    assert.equal((await ingestRawMessage(SYSTEM_ACCOUNT, replyFrom({ from: "newsletter@random.example", id: "u1" }))).reason, "unrelated");
    assert.equal((await ingestRawMessage(SYSTEM_ACCOUNT, replyFrom({ from: "system@mailflow.test", id: "u2" }))).reason, "own-message");
    const { messageId } = await sendTo("copy@acme.example");
    const copy = [`From: x@y.example`, `Message-ID: ${messageId}`, "Subject: copy", "Content-Type: text/plain", "", "x"].join("\r\n");
    assert.equal((await ingestRawMessage(SYSTEM_ACCOUNT, copy)).reason, "own-message");
    assert.equal(await IncomingEmail.countDocuments(), before);
  });

  test("users stay separate on a shared mailbox and on their own", async () => {
    // Bob emails the same address Alice does, through the shared system account.
    await clearDuplicateWindow();
    const aContact = await addContact("shared@acme.example");
    await send([aContact.id]);
    const t = (await bob("GET", "/mailflow/templates")).templates[0];
    const bContact = (await bob("POST", "/mailflow/contacts", { email: "shared@acme.example" })).contact;
    const started = await bob("POST", "/mailflow/campaigns", { templateId: t.id, contactIds: [bContact.id] });
    const done = await waitForCampaign(bob, started.campaign.id);
    const bobMessageId = done.recipients[0].messageId;

    // Threading headers identify the right user.
    const r = await ingestRawMessage(SYSTEM_ACCOUNT, replyFrom({ from: "shared@acme.example", inReplyTo: bobMessageId, id: "s1" }));
    assert.equal(String(r.contactId), bContact.id);
    assert.equal((await getContact(aContact.id)).replyCount, 0);
    assert.equal((await bob("GET", `/mailflow/contacts/${bContact.id}/incoming`)).messages.length, 1);
    assert.equal((await bob("GET", "/mailflow/incoming")).messages.length, 1);
    assert.equal((await alice("GET", `/mailflow/contacts/${bContact.id}/incoming`)).status, 404);

    // Without threading headers it's ambiguous between two users, so it's dropped.
    assert.equal((await ingestRawMessage(SYSTEM_ACCOUNT, replyFrom({ from: "shared@acme.example", id: "s2" }))).reason, "unrelated");

    // A custom mailbox only ever matches its owner's emails through that account.
    const custom = { key: "custom-x", userId: new mongoose.Types.ObjectId(aliceId), accountId: new mongoose.Types.ObjectId(), label: "a@b.example" };
    assert.equal((await ingestRawMessage(custom, replyFrom({ from: "shared@acme.example", inReplyTo: bobMessageId, id: "s3" }))).reason, "unrelated");
  });

  describe("IMAP sync", () => {
    function fakeMailbox(messages, { uidValidity = 111n, failLogin = false } = {}) {
      const log = { readOnly: null, fetched: [], released: 0, loggedOut: 0, searches: [] };
      const client = {
        mailbox: { uidValidity },
        on() {},
        async connect() {
          if (failLogin) throw Object.assign(new Error("Command failed"), { authenticationFailed: true });
        },
        async getMailboxLock(name, opts) {
          log.mailboxName = name;
          log.readOnly = opts?.readOnly;
          return { release: () => log.released++ };
        },
        async search(q) {
          log.searches.push(q);
          if (q.uid) {
            const from = Number(q.uid.split(":")[0]);
            const newest = Math.max(0, ...messages.map((m) => m.uid));
            return [...messages.filter((m) => m.uid >= from).map((m) => m.uid), ...(newest && newest < from ? [newest] : [])];
          }
          return messages.map((m) => m.uid);
        },
        async *fetch(range, query) {
          log.query = query;
          const wanted = new Set(range.split(",").map(Number));
          for (const m of messages) {
            if (wanted.has(m.uid)) {
              log.fetched.push(m.uid);
              yield { uid: m.uid, source: Buffer.from(m.raw), internalDate: new Date() };
            }
          }
        },
        async logout() {
          log.loggedOut++;
        },
      };
      return { client, log };
    }
    const account = { ...SYSTEM_ACCOUNT, key: "imap-test", host: "imap.test", port: 993, user: "u", pass: () => "p" };

    test("reads read-only, remembers its place, finds bounces and replies, ignores the rest", async () => {
      const bounced = await sendTo("imap-bounce@acme.example");
      const replied = await sendTo("imap-reply@acme.example");
      const messages = [
        { uid: 5, raw: replyFrom({ from: "newsletter@random.example", id: "i0" }) },
        { uid: 6, raw: bounceFor({ recipient: "imap-bounce@acme.example", original: bounced.messageId, id: "i1" }) },
        { uid: 7, raw: replyFrom({ from: "imap-reply@acme.example", inReplyTo: replied.messageId, id: "i2" }) },
      ];
      const { client, log } = fakeMailbox(messages);
      setImapClientFactory(() => client);

      const first = await syncMailbox(account);
      assert.deepEqual([first.scanned, first.stored], [3, 2]);
      assert.equal(log.readOnly, true);
      assert.equal(log.mailboxName, "INBOX");
      assert.ok(log.searches[0].since instanceof Date);
      assert.equal(log.query.source.maxLength, 256 * 1024); // attachments aren't downloaded
      assert.equal(log.released, 1);
      assert.equal(log.loggedOut, 1);
      assert.equal((await getContact(bounced.contact.id)).contactStatus, "Hard Bounced");
      assert.equal((await getContact(replied.contact.id)).contactStatus, "Replied");

      // Nothing new: the newest message returned by "n:*" isn't read again.
      const second = await syncMailbox(account);
      assert.equal(second.scanned, 0);
      assert.equal(log.fetched.length, 3);
      assert.equal(log.searches[1].uid, "8:*");

      // A new message only.
      messages.push({ uid: 8, raw: replyFrom({ from: "imap-reply@acme.example", inReplyTo: replied.messageId, id: "i3" }) });
      const third = await syncMailbox(account);
      assert.deepEqual([third.scanned, third.stored], [1, 1]);
      assert.equal((await getContact(replied.contact.id)).replyCount, 2);

      // UIDVALIDITY changed: rescan, and the unique index stops double counting.
      client.mailbox.uidValidity = 222n;
      const fourth = await syncMailbox(account);
      assert.equal(fourth.scanned, 4);
      assert.equal(fourth.stored, 0);
      assert.equal(fourth.duplicates, 3);
      assert.equal((await getContact(replied.contact.id)).replyCount, 2);
    });

    test("a login failure is recorded, not thrown, and contains no credentials", async () => {
      const { client, log } = fakeMailbox([], { failLogin: true });
      setImapClientFactory(() => client);
      const failing = { ...account, key: "imap-fail" };
      const r = await syncMailbox(failing);
      assert.match(r.error, /rejected the login/);
      const state = await MailboxSyncState.findOne({ accountKey: "imap-fail" });
      assert.match(state.lastError, /App Password/);
      assert.equal(state.lockedUntil, null);
      assert.equal(log.loggedOut, 1);
    });

    test("only one sync per mailbox at a time", async () => {
      await MailboxSyncState.updateOne({ accountKey: "imap-lock" }, { $set: { lockedUntil: new Date(Date.now() + 60000) } }, { upsert: true });
      assert.equal((await syncMailbox({ ...account, key: "imap-lock" })).skipped, true);
    });

    test("status and inbound accounts expose no secrets; custom accounts read only when enabled", async () => {
      const made = (await alice("POST", "/mailflow/email-accounts", accountBody({ senderEmail: "reader@work.example", smtpUsername: "reader@work.example", imapEnabled: true, imapHost: "imap.work.example" }))).account;
      const accounts = await listInboundAccounts();
      const mine = accounts.find((a) => a.key === made.id);
      assert.equal(mine.pass(), "super-secret-app-password");
      const status = await alice("GET", "/mailflow/incoming/status");
      assert.ok(status.mailboxes.some((m) => m.key === made.id));
      assert.ok(!JSON.stringify(status).includes("super-secret"));
      assert.ok(!(await bob("GET", "/mailflow/incoming/status")).mailboxes.some((m) => m.key === made.id));
      await alice("DELETE", `/mailflow/email-accounts/${made.id}`);
    });
  });
});

// ---------- analytics ----------

describe("contact analytics", () => {
  test("numbers come from real data, filters narrow them, and users are separate", async () => {
    const carol = client();
    await carol("POST", "/mailflow/auth/register", { name: "Carol", email: "carol@example.com", password: "password123" });
    const t = (await carol("GET", "/mailflow/templates")).templates[0];
    const make = async (email, extra = {}) => (await carol("POST", "/mailflow/contacts", { email, ...extra })).contact;
    const a = await make("ok@one.example", { category: "Hiring", company: "One" });
    const b = await make("hard@two.example", { category: "Client", company: "Two" });
    const c = await make("reply@one.example", { category: "Hiring", company: "One" });
    const d = await make("blocked@three.example", { category: "Hiring", company: "Three" });
    await make("never@three.example", { category: "Client", company: "Three" });
    await carol("PATCH", `/mailflow/contacts/${d.id}/block`, { blocked: true, reason: "no" });
    await carol("POST", `/mailflow/contacts/${a.id}/follow-ups`, { dueAt: new Date(Date.now() + 86400e3).toISOString() });

    const started = await carol("POST", "/mailflow/campaigns", { templateId: t.id, contactIds: [a.id, b.id, c.id] });
    const done = await waitForCampaign(carol, started.campaign.id);
    assert.equal(done.campaign.failedCount, 1);
    const reply = done.recipients.find((r) => r.recipientEmail === "reply@one.example");
    await ingestRawMessage(SYSTEM_ACCOUNT, replyFrom({ from: "reply@one.example", inReplyTo: reply.messageId, id: "an1" }));

    const { analytics: all } = await carol("GET", "/mailflow/contacts/analytics");
    assert.equal(all.totalContacts, 5);
    assert.equal(all.hardBounced, 1);
    assert.equal(all.blocked, 1);
    assert.equal(all.replied, 1);
    assert.equal(all.validContacts, 1);
    assert.equal(all.awaitingReply, 1);
    assert.equal(all.pendingFollowUps, 1);
    assert.equal(all.totalEmailsSent, 3);
    assert.equal(all.acceptedEmails, 2);
    assert.equal(all.failedEmails, 1);
    assert.equal(all.averagePerContact, 0.6);
    assert.equal(all.emailsOverTime.reduce((n, d2) => n + d2.accepted, 0), 2);
    assert.equal(all.incomingOverTime.reduce((n, d2) => n + d2.replies, 0), 1);
    assert.equal(all.replyStats[0].value, 1);
    assert.deepEqual(all.filters.companies, ["One", "Three", "Two"]);
    assert.ok(all.statusDistribution.some((s) => s.name === "Blocked" && s.value === 1));

    const hiring = (await carol("GET", "/mailflow/contacts/analytics?category=Hiring")).analytics;
    assert.equal(hiring.totalContacts, 3);
    assert.equal(hiring.hardBounced, 0);
    assert.equal(hiring.totalEmailsSent, 2);
    assert.equal((await carol("GET", "/mailflow/contacts/analytics?company=One")).analytics.totalContacts, 2);
    assert.equal((await carol("GET", "/mailflow/contacts/analytics?status=Replied")).analytics.totalContacts, 1);

    const past = new Date(Date.now() - 30 * 86400e3).toISOString();
    const earlier = (await carol("GET", `/mailflow/contacts/analytics?from=${past}&to=${new Date(Date.now() - 20 * 86400e3).toISOString()}`)).analytics;
    assert.equal(earlier.totalEmailsSent, 0);
    assert.equal(earlier.totalContacts, 5);
    assert.equal((await carol("GET", "/mailflow/contacts/analytics?from=junk")).status, 400);

    const stranger = client();
    await stranger("POST", "/mailflow/auth/register", { name: "S", email: "stranger@example.com", password: "password123" });
    const none = (await stranger("GET", "/mailflow/contacts/analytics")).analytics;
    assert.equal(none.totalContacts, 0);
    assert.equal(none.totalEmailsSent, 0);
    assert.equal(none.averagePerContact, 0);
  });
});
