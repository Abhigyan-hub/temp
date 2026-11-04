// End-to-end API tests against a real MongoDB (separate `mailflow_test` database) with a fake
// mail transport, so nothing is delivered. Run: npm test
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import "dotenv/config";

const base = process.env.MONGODB_URI;
process.env.MONGODB_URI = base.replace(/\/([^/?]*)(\?|$)/, "/mailflow_test$2");
process.env.NODE_ENV = "test";
process.env.EMAIL_TRANSPORT = "json";
process.env.SEND_DELAY_MS = "0";
process.env.SCHEDULER_ENABLED = "false";
process.env.ALLOWED_SIGNUP_EMAILS = "";

const { connectDB, disconnectDB } = await import("../src/config/db.js");
const { createApp } = await import("../src/app.js");
const { setTransporter } = await import("../src/services/emailService.js");
const { processDue, recoverStale } = await import("../src/services/schedulerService.js");
const { ScheduledEmail } = await import("../src/models/ScheduledEmail.js");
const mongoose = (await import("mongoose")).default;

// Fake transport: records messages; any address containing "bounce" fails like Gmail would.
const outbox = [];
setTransporter({
  sendMail: async (msg) => {
    if (msg.to.includes("bounce")) {
      const err = new Error("Recipient address rejected");
      err.responseCode = 550;
      err.response = "550 5.1.1 user unknown";
      throw err;
    }
    outbox.push(msg);
    return { messageId: `<fake-${outbox.length}@test>` };
  },
});

let server;
let url;

function client() {
  let cookie = "";
  return async function call(method, path, body) {
    const res = await fetch(url + path, {
      method,
      headers: {
        "content-type": "application/json",
        "x-requested-with": "mailflow",
        ...(cookie ? { cookie } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    const json = await res.json().catch(() => ({}));
    return { status: res.status, ...json };
  };
}

const alice = client();
const bob = client();

before(async () => {
  await connectDB();
  await mongoose.connection.db.dropDatabase();
  await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));
  server = createApp().listen(0);
  url = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await mongoose.connection.db.dropDatabase();
  server.close();
  await disconnectDB();
});

describe("auth", () => {
  test("register validates input", async () => {
    const r = await alice("POST", "/mailflow/auth/register", { name: "A", email: "bad", password: "123" });
    assert.equal(r.status, 400);
  });

  test("register creates user, sets cookie, seeds templates, never returns password", async () => {
    const r = await alice("POST", "/mailflow/auth/register", { name: "Alice Doe", email: "Alice@Example.com", password: "password123" });
    assert.equal(r.status, 201);
    assert.equal(r.user.email, "alice@example.com");
    assert.equal(r.user.password, undefined);
    const t = await alice("GET", "/mailflow/templates");
    assert.equal(t.templates.length, 3);
  });

  test("duplicate email is rejected", async () => {
    const r = await bob("POST", "/mailflow/auth/register", { name: "X", email: "alice@example.com", password: "password123" });
    assert.equal(r.status, 409);
  });

  test("wrong password is rejected", async () => {
    const r = await bob("POST", "/mailflow/auth/login", { email: "alice@example.com", password: "nope-nope" });
    assert.equal(r.status, 401);
  });

  test("protected routes require auth", async () => {
    const anon = client();
    assert.equal((await anon("GET", "/mailflow/contacts")).status, 401);
    assert.equal((await anon("GET", "/mailflow/emails/stats")).status, 401);
  });

  test("second user registers", async () => {
    const r = await bob("POST", "/mailflow/auth/register", { name: "Bob", email: "bob@example.com", password: "password123" });
    assert.equal(r.status, 201);
  });

  test("mongo operator injection in login is neutralised", async () => {
    const r = await bob("POST", "/mailflow/auth/login", { email: { $ne: null }, password: { $ne: null } });
    assert.equal(r.status, 400);
  });
});

let contactId;
describe("contacts", () => {
  test("create, duplicate, update, notes", async () => {
    const r = await alice("POST", "/mailflow/contacts", { name: "Rahul", email: "rahul@acme.io", company: "Acme", title: "HR", category: "Hiring" });
    assert.equal(r.status, 201);
    assert.equal(r.contact.serialNo, 1);
    contactId = r.contact.id;
    assert.equal((await alice("POST", "/mailflow/contacts", { name: "R2", email: "RAHUL@acme.io" })).status, 409);
    const u = await alice("PUT", `/mailflow/contacts/${contactId}`, { notes: "Met at conf" });
    assert.equal(u.contact.notes, "Met at conf");
  });

  test("import skips duplicates and invalid rows", async () => {
    const r = await alice("POST", "/mailflow/contacts/import", {
      contacts: [
        { Name: "Priya", Email: "priya@zeta.com", Company: "Zeta", Category: "Hiring" },
        { name: "Priya again", email: "PRIYA@zeta.com" },
        { name: "Rahul dup", email: "rahul@acme.io" },
        { name: "No email" },
        { name: "Bad", email: "not-an-email" },
        { "Full Name": "Bounce", "Email ID": "bounce@nowhere.com", Role: "CTO", Organization: "Nowhere" },
        { name: "Sara", email: "sara@blue.com", category: "Internship" },
      ],
    });
    assert.equal(r.imported, 3);
    assert.equal(r.duplicates, 2);
    assert.equal(r.invalid, 2);
    assert.equal(r.errors.length, 2);
    const list = await alice("GET", "/mailflow/contacts");
    assert.equal(list.contacts.length, 4);
    assert.deepEqual(list.contacts.map((c) => c.serialNo), [1, 2, 3, 4]);
    const bounce = list.contacts.find((c) => c.email === "bounce@nowhere.com");
    assert.equal(bounce.title, "CTO");
    assert.equal(bounce.company, "Nowhere");
  });

  test("search and category filter", async () => {
    assert.equal((await alice("GET", "/mailflow/contacts?search=zeta")).contacts.length, 1);
    assert.equal((await alice("GET", "/mailflow/contacts?category=Hiring")).contacts.length, 2);
    assert.equal((await alice("GET", "/mailflow/contacts?search=.*")).contacts.length, 0); // regex is escaped
  });

  test("users are isolated", async () => {
    assert.equal((await bob("GET", "/mailflow/contacts")).contacts.length, 0);
    assert.equal((await bob("PUT", `/mailflow/contacts/${contactId}`, { name: "hacked" })).status, 404);
    assert.equal((await bob("DELETE", `/mailflow/contacts/${contactId}`)).status, 404);
    assert.equal((await bob("PATCH", `/mailflow/contacts/${contactId}/block`, {})).status, 404);
    // Bob can still add the same email to his own list.
    assert.equal((await bob("POST", "/mailflow/contacts", { email: "rahul@acme.io" })).status, 201);
  });

  test("invalid id gives 400", async () => {
    assert.equal((await alice("PUT", "/mailflow/contacts/123", { name: "x" })).status, 400);
  });
});

let templateId;
describe("templates", () => {
  test("crud, duplicate, favourite, search", async () => {
    const c = await alice("POST", "/mailflow/templates", { name: "Intro", subject: "Hi {{company}}", body: "Hello {{name|there}} <b>{{title}}</b>", category: "Client" });
    assert.equal(c.status, 201);
    templateId = c.template.id;
    const d = await alice("POST", `/mailflow/templates/${templateId}/duplicate`);
    assert.equal(d.template.name, "Intro (Copy)");
    const f = await alice("PATCH", `/mailflow/templates/${d.template.id}/favorite`);
    assert.equal(f.template.isFavorite, true);
    assert.equal((await alice("PUT", `/mailflow/templates/${d.template.id}`, { subject: "" })).status, 400);
    assert.equal((await alice("DELETE", `/mailflow/templates/${d.template.id}`)).status, 200);
    assert.equal((await alice("GET", "/mailflow/templates?search=hello")).templates.length, 1);
    assert.equal((await bob("GET", `/mailflow/templates?search=hello`)).templates.length, 0);
  });
});

describe("sending", () => {
  let ids;
  test("personalises, escapes HTML, records failures, skips blocked", async () => {
    const contacts = (await alice("GET", "/mailflow/contacts")).contacts;
    ids = Object.fromEntries(contacts.map((c) => [c.email, c.id]));
    await alice("PATCH", `/mailflow/contacts/${ids["sara@blue.com"]}/block`, {});
    await alice("PUT", `/mailflow/contacts/${ids["priya@zeta.com"]}`, { name: "", title: "<script>x</script>" });

    const r = await alice("POST", "/mailflow/emails/send", { templateId, contactIds: Object.values(ids) });
    assert.equal(r.status, 200);
    assert.equal(r.sent, 2);
    assert.equal(r.failed, 1);
    assert.equal(r.skipped, 1);

    const priyaMail = outbox.find((m) => m.to === "priya@zeta.com");
    assert.equal(priyaMail.subject, "Hi Zeta");
    assert.match(priyaMail.text, /^Hello there /);
    assert.match(priyaMail.html, /&lt;b&gt;&lt;script&gt;x&lt;\/script&gt;&lt;\/b&gt;/);
    assert.doesNotMatch(priyaMail.html, /<script>/);
    assert.match(priyaMail.from, /"Alice Doe" <.+>/);

    const failed = r.results.find((x) => x.email === "bounce@nowhere.com");
    assert.match(failed.error, /Recipient rejected/);

    const contacts2 = (await alice("GET", "/mailflow/contacts")).contacts;
    const byEmail = Object.fromEntries(contacts2.map((c) => [c.email, c]));
    assert.equal(byEmail["priya@zeta.com"].emailStatus, "Sent");
    assert.equal(byEmail["bounce@nowhere.com"].emailStatus, "Failed");
    assert.equal(byEmail["sara@blue.com"].isBlocked, true);
  });

  test("re-sending the same template right away is skipped as a duplicate", async () => {
    const before = outbox.length;
    const r = await alice("POST", "/mailflow/emails/send", { templateId, contactIds: [ids["priya@zeta.com"]] });
    assert.equal(r.skipped, 1);
    assert.equal(outbox.length, before);
  });

  test("cannot send another user's template or to their contacts", async () => {
    const r = await bob("POST", "/mailflow/emails/send", { templateId, contactIds: [ids["priya@zeta.com"]] });
    assert.equal(r.status, 404);
  });

  test("history and stats reflect real sends", async () => {
    const h = await alice("GET", "/mailflow/emails/history");
    assert.equal(h.history.length, 3);
    assert.ok(h.history.every((x) => x.body === undefined));
    const s = (await alice("GET", "/mailflow/emails/stats")).stats;
    assert.equal(s.totalContacts, 4);
    assert.equal(s.sent, 2);
    assert.equal(s.failed, 1);
    assert.equal(s.blockedContacts, 1);
    assert.equal(s.daily.reduce((a, d) => a + d.sent, 0), 2);
    const bs = (await bob("GET", "/mailflow/emails/stats")).stats;
    assert.equal(bs.sent, 0);
  });
});

describe("scheduling", () => {
  let contacts;
  test("rejects past times", async () => {
    contacts = (await alice("GET", "/mailflow/contacts")).contacts;
    const r = await alice("POST", "/mailflow/schedules", {
      templateId,
      contactIds: [contacts[0].id],
      scheduledAt: new Date(Date.now() - 3600_000).toISOString(),
    });
    assert.equal(r.status, 400);
  });

  test("future schedules wait; due schedules are sent by the worker exactly once", async () => {
    const rahul = contacts.find((c) => c.email === "rahul@acme.io");
    const future = await alice("POST", "/mailflow/schedules", {
      templateId,
      contactIds: [rahul.id],
      scheduledAt: new Date(Date.now() + 3600_000).toISOString(),
      timezone: "Asia/Kolkata",
    });
    assert.equal(future.scheduled, 1);
    const dupe = await alice("POST", "/mailflow/schedules", {
      templateId,
      contactIds: [rahul.id],
      scheduledAt: future.schedules[0].scheduledAt,
    });
    assert.equal(dupe.scheduled, 0);

    assert.equal((await processDue({ delayMs: 0 })).processed, 0);

    // Make it due, then race two workers on the same document.
    await ScheduledEmail.updateOne({ _id: future.schedules[0].id }, { scheduledAt: new Date(Date.now() - 1000) });
    const before = outbox.length;
    const claims = await Promise.all(
      Array.from({ length: 5 }, () =>
        ScheduledEmail.findOneAndUpdate(
          { _id: future.schedules[0].id, status: "Pending" },
          { status: "Processing", lockedAt: new Date(), lockedBy: "race" },
        ),
      ),
    );
    assert.equal(claims.filter(Boolean).length, 1);
    await ScheduledEmail.updateOne({ _id: future.schedules[0].id }, { status: "Pending", $unset: { lockedAt: 1, lockedBy: 1 } });

    const run = await processDue({ delayMs: 0 });
    assert.equal(run.Sent, 1);
    assert.equal(outbox.length, before + 1);
    assert.equal((await processDue({ delayMs: 0 })).processed, 0);

    const list = (await alice("GET", "/mailflow/schedules")).schedules;
    const s = list.find((x) => x.id === future.schedules[0].id);
    assert.equal(s.status, "Sent");
    assert.equal(s.contact.email, "rahul@acme.io");
    assert.equal(s.template.name, "Intro");
  });

  test("cancel, reschedule, send-now, delete, isolation", async () => {
    const bounce = contacts.find((c) => c.email === "bounce@nowhere.com");
    const r = await alice("POST", "/mailflow/schedules", {
      templateId,
      contactIds: [bounce.id],
      scheduledAt: new Date(Date.now() + 86400_000).toISOString(),
    });
    const id = r.schedules[0].id;
    assert.equal((await alice("GET", "/mailflow/contacts?status=Scheduled")).contacts.length, 0); // was Failed, keeps status

    assert.equal((await bob("PATCH", `/mailflow/schedules/${id}/cancel`)).status, 409);
    assert.equal((await bob("GET", "/mailflow/schedules")).schedules.length, 0);

    const later = new Date(Date.now() + 2 * 86400_000).toISOString();
    const u = await alice("PATCH", `/mailflow/schedules/${id}`, { scheduledAt: later, comments: "moved" });
    assert.equal(u.schedule.comments, "moved");

    const sn = await alice("POST", `/mailflow/schedules/${id}/send-now`);
    assert.equal(sn.schedule.status, "Failed"); // bounce@ fails in the fake transport
    assert.match(sn.schedule.errorMessage, /Recipient rejected/);
    assert.equal((await alice("PATCH", `/mailflow/schedules/${id}/cancel`)).status, 409);

    const r2 = await alice("POST", "/mailflow/schedules", {
      templateId,
      contactIds: [bounce.id],
      scheduledAt: new Date(Date.now() + 86400_000).toISOString(),
    });
    const c = await alice("PATCH", `/mailflow/schedules/${r2.schedules[0].id}/cancel`);
    assert.equal(c.schedule.status, "Cancelled");
    assert.equal((await alice("DELETE", `/mailflow/schedules/${r2.schedules[0].id}`)).status, 200);
  });

  test("blocking a contact cancels its pending schedules", async () => {
    const priya = contacts.find((c) => c.email === "priya@zeta.com");
    const r = await alice("POST", "/mailflow/schedules", {
      templateId,
      contactIds: [priya.id],
      scheduledAt: new Date(Date.now() + 86400_000).toISOString(),
    });
    await alice("PATCH", `/mailflow/contacts/${priya.id}/block`, { blocked: true });
    const s = (await alice("GET", "/mailflow/schedules")).schedules.find((x) => x.id === r.schedules[0].id);
    assert.equal(s.status, "Cancelled");
  });

  test("restart recovery: unsent stale jobs are re-queued, ambiguous ones are not re-sent", async () => {
    const rahul = contacts.find((c) => c.email === "rahul@acme.io");
    const user = (await alice("GET", "/mailflow/auth/me")).user;
    const old = new Date(Date.now() - 60 * 60 * 1000);
    const common = { userId: user.id, contactId: rahul.id, templateId, status: "Processing", lockedAt: old, lockedBy: "dead-worker" };
    const neverSent = await ScheduledEmail.create({ ...common, scheduledAt: new Date(Date.now() - 5000) });
    const midSend = await ScheduledEmail.create({ ...common, scheduledAt: new Date(Date.now() - 4000), sendingStartedAt: old });

    const rec = await recoverStale();
    assert.deepEqual(rec, { requeued: 1, failed: 1 });
    assert.equal((await ScheduledEmail.findById(neverSent._id)).status, "Pending");
    assert.equal((await ScheduledEmail.findById(midSend._id)).status, "Failed");

    const run = await processDue({ delayMs: 0 });
    assert.equal(run.Sent, 1);
  });
});

describe("password reset and settings", () => {
  test("forgot → reset → old session revoked → login with new password", async () => {
    const before = outbox.length;
    const generic = await bob("POST", "/mailflow/auth/forgot-password", { email: "nobody@example.com" });
    assert.equal(generic.status, 200);
    assert.equal(outbox.length, before);

    await bob("POST", "/mailflow/auth/forgot-password", { email: "alice@example.com" });
    const mail = outbox.at(-1);
    assert.equal(mail.to, "alice@example.com");
    const token = mail.text.match(/token=([a-f0-9]{64})/)[1];

    assert.equal((await bob("POST", "/mailflow/auth/reset-password", { token: "0".repeat(64), password: "newpassword1" })).status, 400);
    assert.equal((await bob("POST", "/mailflow/auth/reset-password", { token, password: "newpassword1" })).status, 200);
    assert.equal((await bob("POST", "/mailflow/auth/reset-password", { token, password: "newpassword2" })).status, 400);

    assert.equal((await alice("GET", "/mailflow/auth/me")).status, 401);
    assert.equal((await alice("POST", "/mailflow/auth/login", { email: "alice@example.com", password: "password123" })).status, 401);
    assert.equal((await alice("POST", "/mailflow/auth/login", { email: "alice@example.com", password: "newpassword1" })).status, 200);
  });

  test("settings persist and validate", async () => {
    const r = await alice("PUT", "/mailflow/settings", {
      name: "Alice D",
      profile: { senderName: "Alice from Acme", signature: "-- Alice" },
      settings: { timezone: "Asia/Kolkata" },
    });
    assert.equal(r.user.profile.senderName, "Alice from Acme");
    assert.equal((await alice("PUT", "/mailflow/settings", { settings: { timezone: "Mars/Base" } })).status, 400);
    assert.equal((await alice("PUT", "/mailflow/settings", { email: "bob@example.com" })).status, 409);
    const g = await alice("GET", "/mailflow/settings");
    assert.equal(g.user.settings.timezone, "Asia/Kolkata");
  });

  test("change password", async () => {
    assert.equal((await alice("PUT", "/mailflow/auth/password", { currentPassword: "wrong", newPassword: "another-pass" })).status, 400);
    assert.equal((await alice("PUT", "/mailflow/auth/password", { currentPassword: "newpassword1", newPassword: "another-pass" })).status, 200);
    assert.equal((await alice("GET", "/mailflow/auth/me")).status, 200); // new cookie issued
  });

  test("logout clears the session", async () => {
    await alice("POST", "/mailflow/auth/logout");
    assert.equal((await alice("GET", "/mailflow/auth/me")).status, 401);
  });
});

describe("contact fields, company extraction and notes", () => {
  const carol = client();
  let id;

  test("a contact can be created with only an email; company comes from the domain", async () => {
    await carol("POST", "/mailflow/auth/register", { name: "Carol", email: "carol@example.com", password: "password123" });
    const r = await carol("POST", "/mailflow/contacts", { email: "  Recruiter@Infosys.co.in " });
    assert.equal(r.status, 201);
    assert.equal(r.contact.email, "recruiter@infosys.co.in");
    assert.equal(r.contact.company, "Infosys");
    assert.equal(r.contact.name, "");
    assert.equal(r.contact.title, "");
    assert.equal(r.contact.noteUpdatedAt, null);
    id = r.contact.id;
  });

  test("a manually entered company is kept; all fields saved", async () => {
    const r = await carol("POST", "/mailflow/contacts", {
      name: "Sundar", email: "hr@google.com", title: "CEO", company: "Alphabet", category: "Tech", notes: "Met at I/O",
    });
    assert.equal(r.contact.company, "Alphabet");
    assert.equal(r.contact.notes, "Met at I/O");
    assert.ok(r.contact.noteUpdatedAt);
    assert.equal((await carol("POST", "/mailflow/contacts", { email: "careers@microsoft.com" })).contact.company, "Microsoft");
    assert.equal((await carol("POST", "/mailflow/contacts", { email: "dean@iitb.ac.in" })).contact.company, "Iitb");
    assert.equal((await carol("POST", "/mailflow/contacts", { email: "me@gmail.com" })).contact.company, "");
  });

  test("email is still required and validated; duplicates rejected", async () => {
    assert.equal((await carol("POST", "/mailflow/contacts", { name: "No email" })).status, 400);
    assert.equal((await carol("POST", "/mailflow/contacts", { email: "nope" })).status, 400);
    assert.equal((await carol("POST", "/mailflow/contacts", { email: "HR@google.com" })).status, 409);
  });

  test("every field is editable; history survives; noteUpdatedAt only moves when notes change", async () => {
    const templates = (await carol("GET", "/mailflow/templates")).templates;
    const sent = await carol("POST", "/mailflow/emails/send", { templateId: templates[0].id, contactIds: [id] });
    assert.equal(sent.sent, 1);

    const n1 = await carol("PUT", `/mailflow/contacts/${id}`, { notes: "Interested in SDE roles" });
    const firstStamp = n1.contact.noteUpdatedAt;
    assert.ok(firstStamp);

    await new Promise((r) => setTimeout(r, 20));
    const e = await carol("PUT", `/mailflow/contacts/${id}`, {
      name: "Asha Rao", email: "asha@tcs.com", title: "Talent Lead", company: "", category: "IT", notes: "Interested in SDE roles",
    });
    assert.equal(e.status, 200);
    assert.equal(e.contact.id, id);
    assert.equal(e.contact.email, "asha@tcs.com");
    assert.equal(e.contact.company, "TCS"); // cleared company re-derived from the new email
    assert.equal(e.contact.noteUpdatedAt, firstStamp); // unrelated edits keep the timestamp
    assert.equal(e.contact.emailStatus, "Sent");

    await new Promise((r) => setTimeout(r, 20));
    const n2 = await carol("PUT", `/mailflow/contacts/${id}`, { notes: "Call next week" });
    assert.ok(new Date(n2.contact.noteUpdatedAt) > new Date(firstStamp));
    const cleared = await carol("PUT", `/mailflow/contacts/${id}`, { notes: "" });
    assert.equal(cleared.contact.noteUpdatedAt, null);

    const h = await carol("GET", `/mailflow/emails/history?contactId=${id}`);
    assert.equal(h.history.length, 1);
    assert.equal(h.history[0].recipient, "recruiter@infosys.co.in");

    assert.equal((await carol("PUT", `/mailflow/contacts/${id}`, { email: "hr@google.com" })).status, 409);
    assert.equal((await carol("PUT", `/mailflow/contacts/${id}`, { email: "asha@tcs.com" })).status, 200); // own email is fine
    assert.equal((await carol("PUT", `/mailflow/contacts/${id}`, { email: "bad" })).status, 400);

    const blocked = await carol("PATCH", `/mailflow/contacts/${id}/block`, { blocked: true });
    assert.equal(blocked.contact.isBlocked, true);
    assert.equal((await carol("PATCH", `/mailflow/contacts/${id}/block`, { blocked: false })).contact.isBlocked, false);
  });

  test("another user cannot edit these contacts", async () => {
    assert.equal((await bob("PUT", `/mailflow/contacts/${id}`, { notes: "x" })).status, 404);
  });

  test("import accepts missing optional fields, derives companies and reports counts", async () => {
    const r = await carol("POST", "/mailflow/contacts/import", {
      contacts: [
        { Email: "jobs@amazon.in" },
        { Name: "Full", Email: "x@zeta.io", Title: "HR", Company: "Zeta Labs", Notes: "hello" },
        { email: "ASHA@tcs.com" },
        { email: "broken" },
      ],
    });
    assert.equal(r.imported, 2);
    assert.equal(r.duplicates, 1);
    assert.equal(r.invalid, 1);
    assert.equal(r.missingOptional, 1);
    assert.equal(r.companyFromEmail, 1);
    const list = (await carol("GET", "/mailflow/contacts")).contacts;
    assert.equal(list.find((c) => c.email === "jobs@amazon.in").company, "Amazon");
    const zeta = list.find((c) => c.email === "x@zeta.io");
    assert.equal(zeta.company, "Zeta Labs");
    assert.ok(zeta.noteUpdatedAt);
  });
});

describe("blocking with a reason and an end date", () => {
  const dave = client();
  let template;
  let c1;
  let c2;
  const inDays = (d) => new Date(Date.now() + d * 86400e3).toISOString();

  before(async () => {
    await dave("POST", "/mailflow/auth/register", { name: "Dave", email: "dave@example.com", password: "password123" });
    template = (await dave("GET", "/mailflow/templates")).templates[0];
    c1 = (await dave("POST", "/mailflow/contacts", { email: "hr@blockme.com", name: "Block Me" })).contact;
    c2 = (await dave("POST", "/mailflow/contacts", { email: "ok@fine.com" })).contact;
  });

  test("block until a date with a reason; validation", async () => {
    assert.equal((await dave("PATCH", `/mailflow/contacts/${c1.id}/block`, { blocked: true, until: inDays(-1) })).status, 400);
    const r = await dave("PATCH", `/mailflow/contacts/${c1.id}/block`, { blocked: true, reason: "Asked not to be contacted", until: inDays(7) });
    assert.equal(r.status, 200);
    assert.equal(r.contact.isBlocked, true);
    assert.equal(r.contact.blockReason, "Asked not to be contacted");
    assert.ok(r.contact.blockedAt);
    assert.ok(new Date(r.contact.blockedUntil) > new Date());
  });

  test("sending skips the contact and says why and until when", async () => {
    const r = await dave("POST", "/mailflow/emails/send", { templateId: template.id, contactIds: [c1.id, c2.id] });
    assert.equal(r.sent, 1);
    const skipped = r.results.find((x) => x.contactId === c1.id);
    assert.equal(skipped.status, "Skipped");
    assert.match(skipped.error, /^Blocked until .+: Asked not to be contacted$/);
    assert.equal(skipped.blockReason, "Asked not to be contacted");
    assert.ok(skipped.blockedUntil);
  });

  test("scheduling: inside the block is refused with the reason, after it is allowed", async () => {
    const inside = await dave("POST", "/mailflow/schedules", { templateId: template.id, contactIds: [c1.id, c2.id], scheduledAt: inDays(2) });
    assert.equal(inside.scheduled, 1);
    assert.equal(inside.blocked.length, 1);
    assert.equal(inside.blocked[0].reason, "Asked not to be contacted");
    const afterBlock = await dave("POST", "/mailflow/schedules", { templateId: template.id, contactIds: [c1.id], scheduledAt: inDays(10) });
    assert.equal(afterBlock.scheduled, 1);
  });

  test("re-blocking cancels only schedules inside the new block", async () => {
    const soon = await dave("POST", "/mailflow/schedules", { templateId: template.id, contactIds: [c2.id], scheduledAt: inDays(3) });
    const later = await dave("POST", "/mailflow/schedules", { templateId: template.id, contactIds: [c2.id], scheduledAt: inDays(20) });
    await dave("PATCH", `/mailflow/contacts/${c2.id}/block`, { blocked: true, reason: "Out of office", until: inDays(5) });
    const list = (await dave("GET", "/mailflow/schedules")).schedules;
    const s1 = list.find((s) => s.id === soon.schedules[0].id);
    assert.equal(s1.status, "Cancelled");
    assert.match(s1.errorMessage, /Blocked until .+: Out of office/);
    assert.equal(list.find((s) => s.id === later.schedules[0].id).status, "Pending");
  });

  test("an indefinite block has no end date and says so", async () => {
    const r = await dave("PATCH", `/mailflow/contacts/${c2.id}/block`, { blocked: true, reason: "Unsubscribed", until: null });
    assert.equal(r.contact.blockedUntil, null);
    const s = await dave("POST", "/mailflow/emails/send", { templateId: template.id, contactIds: [c2.id] });
    assert.equal(s.results[0].error, "Blocked until you unblock: Unsubscribed");
  });

  test("the scheduler cancels a due job for a blocked contact with the reason", async () => {
    const c3 = (await dave("POST", "/mailflow/contacts", { email: "late@block.io" })).contact;
    const r = await dave("POST", "/mailflow/schedules", { templateId: template.id, contactIds: [c3.id], scheduledAt: inDays(1) });
    await ScheduledEmail.updateOne({ _id: r.schedules[0].id }, { scheduledAt: new Date(Date.now() - 1000) });
    // Blocked directly in the DB after scheduling, so the API's own cancellation doesn't run.
    await mongoose.model("Contact").updateOne({ _id: c3.id }, { isBlocked: true, blockReason: "Bounced twice", blockedAt: new Date(), blockedUntil: null });
    await processDue({ delayMs: 0 });
    const s = await ScheduledEmail.findById(r.schedules[0].id);
    assert.equal(s.status, "Cancelled");
    assert.equal(s.errorMessage, "Blocked until you unblock: Bounced twice");
  });

  test("expired blocks lift automatically", async () => {
    await mongoose.model("Contact").updateOne({ _id: c1.id }, { blockedUntil: new Date(Date.now() - 1000) });
    const list = (await dave("GET", "/mailflow/contacts")).contacts;
    const c = list.find((x) => x.id === c1.id);
    assert.equal(c.isBlocked, false);
    assert.equal(c.blockReason, "");
    assert.equal(c.blockedUntil, null);
    const s = await dave("POST", "/mailflow/emails/send", { templateId: template.id, contactIds: [c1.id] });
    assert.equal(s.sent, 1);
  });

  test("unblocking clears the reason and dates", async () => {
    const r = await dave("PATCH", `/mailflow/contacts/${c2.id}/block`, { blocked: false });
    assert.equal(r.contact.isBlocked, false);
    assert.equal(r.contact.blockReason, "");
    assert.equal(r.contact.blockedAt, null);
  });

  test("sends report dry-run mode so undelivered mail is never mistaken for sent", async () => {
    const r = await dave("POST", "/mailflow/emails/send", { templateId: template.id, contactIds: [c2.id] });
    assert.equal(r.dryRun, true); // tests run with EMAIL_TRANSPORT=json
    const stats = await dave("GET", "/mailflow/emails/stats");
    assert.equal(stats.stats.emailMode, "dry-run");
    assert.equal(stats.stats.recent[0].dryRun, true);
  });
});
