// Resume Library + attachment tests. Real MongoDB (`mailflow_test_resumes`, dropped afterwards),
// local storage in a temp dir, an in-process fake S3 server, and a fake mail transport.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import zlib from "node:zlib";
import "dotenv/config";

process.env.MONGODB_URI = process.env.MONGODB_URI.replace(/\/([^/?]*)(\?|$)/, "/mailflow_test_resumes$2");
process.env.NODE_ENV = "test";
process.env.EMAIL_TRANSPORT = "json";
process.env.SEND_DELAY_MS = "0";
process.env.SCHEDULER_ENABLED = "false";
process.env.RESUME_MAX_MB = "0.2"; // ~200 KB so the size limit is easy to hit
process.env.ATTACHMENT_MAX_COUNT = "3";
process.env.STORAGE_DRIVER = "local";

const { connectDB, disconnectDB } = await import("../src/config/db.js");
const { createApp } = await import("../src/app.js");
const { setTransporter } = await import("../src/services/emailService.js");
const { processDue } = await import("../src/services/schedulerService.js");
const { setStorage } = await import("../src/services/storage/index.js");
const { createLocalStorage } = await import("../src/services/storage/local.js");
const { createS3Storage } = await import("../src/services/storage/s3.js");
const { Resume } = await import("../src/models/Resume.js");
const { ScheduledEmail } = await import("../src/models/ScheduledEmail.js");
const mongoose = (await import("mongoose")).default;

// ---------- fixtures ----------

const pdf = (label = randomBytes(6).toString("hex")) =>
  Buffer.from(`%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n% ${label}\ntrailer << /Root 1 0 R >>\n%%EOF\n`);

/** Minimal stored (uncompressed) ZIP, enough to be a real .docx. */
function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const data = Buffer.from(text);
    const nameBuf = Buffer.from(name);
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
const docx = (extra = {}) =>
  zip({
    "[Content_Types].xml": `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`,
    "word/document.xml": `<w:document><w:body><w:p><w:r><w:t>Resume ${randomBytes(4).toString("hex")}</w:t></w:r></w:p></w:body></w:document>`,
    ...extra,
  });
const doc = () =>
  Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(504), Buffer.from("WordDocument", "utf16le"), randomBytes(64)]);

// ---------- fakes ----------

const outbox = [];
setTransporter({
  sendMail: async (msg) => {
    outbox.push(msg);
    return { messageId: `<fake-${outbox.length}@test>` };
  },
});

const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "mailflow-resumes-"));
let localStorage = createLocalStorage(storageDir);
setStorage(localStorage);

let server;
let url;

function client() {
  let cookie = "";
  return async function call(method, p, body, { raw = false } = {}) {
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
}

function form(files, fields = {}) {
  const f = new FormData();
  for (const [name, buf, type = "application/octet-stream"] of files) f.append("files", new Blob([buf], { type }), name);
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  return f;
}

const alice = client();
const bob = client();

before(async () => {
  await connectDB();
  await mongoose.connection.db.dropDatabase();
  await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));
  server = createApp().listen(0);
  url = `http://127.0.0.1:${server.address().port}`;
  await alice("POST", "/mailflow/auth/register", { name: "Alice", email: "alice@example.com", password: "password123" });
  await bob("POST", "/mailflow/auth/register", { name: "Bob", email: "bob@example.com", password: "password123" });
});

after(async () => {
  await mongoose.connection.db.dropDatabase();
  server.close();
  await disconnectDB();
  fs.rmSync(storageDir, { recursive: true, force: true });
});

// ---------- tests ----------

const files = {};

describe("upload and validation", () => {
  test("one PDF", async () => {
    const r = await alice("POST", "/mailflow/resumes/upload", form([["Khushant MERN Resume.pdf", pdf("one"), "application/pdf"]], { category: "MERN Stack Developer", description: "Main" }));
    assert.equal(r.status, 201);
    assert.equal(r.uploaded.length, 1);
    const res = r.uploaded[0];
    assert.equal(res.name, "Khushant MERN Resume");
    assert.equal(res.fileType, "pdf");
    assert.equal(res.category, "MERN Stack Developer");
    assert.equal(res.storageKey, undefined);
    assert.equal(res.sha256, undefined);
    assert.ok(res.uploadedAt && res.fileSize > 0);
    files.mern = res;
  });

  test("several files at once: PDF, DOCX, DOC; duplicates detected", async () => {
    const second = pdf("two");
    const r = await alice(
      "POST",
      "/mailflow/resumes/upload",
      form([
        ["Frontend.pdf", second],
        ["Frontend copy.pdf", second],
        ["Again.pdf", pdf("one")],
        ["Full Stack.docx", docx()],
        ["Legacy.doc", doc()],
      ]),
    );
    assert.equal(r.status, 201);
    assert.deepEqual(r.uploaded.map((u) => u.fileType).sort(), ["doc", "docx", "pdf"]);
    assert.equal(r.duplicates.length, 2);
    assert.equal(r.duplicates.find((d) => d.fileName === "Again.pdf").existing.name, "Khushant MERN Resume");
    files.frontend = r.uploaded.find((u) => u.fileType === "pdf");
    files.docx = r.uploaded.find((u) => u.fileType === "docx");
    files.doc = r.uploaded.find((u) => u.fileType === "doc");
  });

  test("invalid content, renamed files, active content, macros and oversized files are rejected", async () => {
    const r = await alice(
      "POST",
      "/mailflow/resumes/upload",
      form([
        ["virus.pdf", Buffer.concat([Buffer.from("MZ"), randomBytes(200)])],
        ["notes.txt", Buffer.from("plain text")],
        ["renamed.docx", pdf("renamed")],
        ["script.pdf", Buffer.from("%PDF-1.4\n<< /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >>\n%%EOF")],
        ["macro.docx", docx({ "word/vbaProject.bin": "x" })],
        ["big.pdf", Buffer.concat([pdf("big"), Buffer.alloc(300 * 1024, 32)])],
        ["../../etc/passwd.pdf", Buffer.alloc(0)],
      ]),
    );
    assert.equal(r.status, 200);
    assert.equal(r.uploaded.length, 0);
    const reasons = Object.fromEntries(r.rejected.map((x) => [x.fileName, x.reason]));
    assert.match(reasons["virus.pdf"], /Only PDF and Word/);
    assert.match(reasons["notes.txt"], /Only PDF and Word/);
    assert.match(reasons["renamed.docx"], /content is PDF/);
    assert.match(reasons["script.pdf"], /scripts/);
    assert.match(reasons["macro.docx"], /macros/);
    assert.match(reasons["big.pdf"], /limit/);
    assert.match(reasons["passwd.pdf"], /empty/); // the directory part never reaches the server code
  });

  test("path-like filenames are reduced to a safe display name", async () => {
    const r = await alice("POST", "/mailflow/resumes/upload", form([["..\\..\\secret\\My<Resume>.pdf", pdf("path")]]));
    assert.equal(r.uploaded[0].name, "My Resume");
    const stored = await Resume.findById(r.uploaded[0].id);
    assert.match(stored.storageKey, /^resumes\/[a-f0-9]{24}\/[0-9a-f-]{36}\.pdf$/);
    assert.equal((await alice("DELETE", `/mailflow/resumes/${r.uploaded[0].id}`)).status, 200);
  });

  test("too many files and non-multipart bodies are refused", async () => {
    const many = Array.from({ length: 11 }, (_, i) => [`r${i}.pdf`, pdf(`many${i}`)]);
    assert.equal((await alice("POST", "/mailflow/resumes/upload", form(many))).status, 400);
    assert.equal((await alice("POST", "/mailflow/resumes/upload", { files: [] })).status, 400);
    assert.equal(await Resume.countDocuments({ name: /^r\d+$/ }), 0);
  });

  test("upload requires auth and the CSRF header", async () => {
    const anon = client();
    assert.equal((await anon("POST", "/mailflow/resumes/upload", form([["a.pdf", pdf()]]))).status, 401);
    const res = await fetch(`${url}/mailflow/resumes/upload`, { method: "POST", body: form([["a.pdf", pdf()]]) });
    assert.equal(res.status, 403);
  });
});

describe("library management", () => {
  test("list, search and filter", async () => {
    const all = await alice("GET", "/mailflow/resumes");
    assert.equal(all.resumes.length, 4);
    assert.equal((await alice("GET", "/mailflow/resumes?fileType=docx")).resumes.length, 1);
    assert.equal((await alice("GET", "/mailflow/resumes?category=MERN%20Stack%20Developer")).resumes.length, 1);
    assert.equal((await alice("GET", "/mailflow/resumes?search=mern")).resumes.length, 1);
  });

  test("rename, describe, label and recategorise", async () => {
    const r = await alice("PUT", `/mailflow/resumes/${files.frontend.id}`, {
      name: "Khushant React Resume",
      description: "For React roles",
      labels: ["react", "2026", "react"],
      category: "My Custom Category",
    });
    assert.equal(r.resume.name, "Khushant React Resume");
    assert.deepEqual(r.resume.labels, ["react", "2026"]);
    assert.equal((await alice("PUT", `/mailflow/resumes/${files.frontend.id}`, { name: "  " })).status, 400);
  });

  test("categories: defaults seeded once, custom ones created, renamed and deleted", async () => {
    const list = await alice("GET", "/mailflow/resume-categories");
    const names = list.categories.map((c) => c.name);
    for (const n of ["MERN Stack Developer", "AI/ML Developer", "General Resume", "My Custom Category"]) assert.ok(names.includes(n), n);
    assert.equal(list.categories.find((c) => c.name === "MERN Stack Developer").resumeCount, 1);

    const created = await alice("POST", "/mailflow/resume-categories", { name: "Data Engineer" });
    assert.equal(created.status, 201);
    assert.equal((await alice("POST", "/mailflow/resume-categories", { name: "data engineer" })).status, 409);

    const custom = list.categories.find((c) => c.name === "My Custom Category");
    await alice("PUT", `/mailflow/resume-categories/${custom.id}`, { name: "React Roles" });
    assert.equal((await alice("GET", `/mailflow/resumes/${files.frontend.id}`)).resume.category, "React Roles");

    const general = list.categories.find((c) => c.name === "General Resume");
    await alice("DELETE", `/mailflow/resume-categories/${general.id}`);
    const again = await alice("GET", "/mailflow/resume-categories");
    assert.ok(!again.categories.some((c) => c.name === "General Resume")); // not re-seeded

    assert.ok(!(await bob("GET", "/mailflow/resume-categories")).categories.some((c) => c.name === "React Roles"));
    assert.equal((await bob("PUT", `/mailflow/resume-categories/${custom.id}`, { name: "x" })).status, 404);
  });

  test("preview and download stream the exact bytes with safe headers", async () => {
    const res = await alice("GET", `/mailflow/resumes/${files.mern.id}/download`, null, { raw: true });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/pdf");
    assert.match(res.headers.get("content-disposition"), /^attachment; filename="Khushant_MERN_Resume\.pdf"/);
    assert.equal(res.headers.get("cache-control"), "private, no-store");
    assert.ok(Buffer.from(await res.arrayBuffer()).equals(pdf("one")));

    const inline = await alice("GET", `/mailflow/resumes/${files.mern.id}/download?inline=1`, null, { raw: true });
    assert.match(inline.headers.get("content-disposition"), /^inline;/);
    await inline.arrayBuffer();
  });

  test("other users can't see, read, change, delete or attach the resume", async () => {
    assert.equal((await bob("GET", "/mailflow/resumes")).resumes.length, 0);
    assert.equal((await bob("GET", `/mailflow/resumes/${files.mern.id}`)).status, 404);
    assert.equal((await bob("GET", `/mailflow/resumes/${files.mern.id}/download`, null, { raw: true })).status, 404);
    assert.equal((await bob("PUT", `/mailflow/resumes/${files.mern.id}`, { name: "x" })).status, 404);
    assert.equal((await bob("DELETE", `/mailflow/resumes/${files.mern.id}`)).status, 404);
    const c = await bob("POST", "/mailflow/contacts", { email: "someone@acme.io" });
    const t = (await bob("GET", "/mailflow/templates")).templates[0];
    const send = await bob("POST", "/mailflow/emails/send", { templateId: t.id, contactIds: [c.contact.id], resumeIds: [files.mern.id] });
    assert.equal(send.status, 404);
    const sched = await bob("POST", "/mailflow/schedules", {
      templateId: t.id, contactIds: [c.contact.id], resumeIds: [files.mern.id], scheduledAt: new Date(Date.now() + 3600e3).toISOString(),
    });
    assert.equal(sched.status, 404);
    assert.equal(outbox.length, 0);
  });

  test("files survive a restart (new app + new storage instance)", async () => {
    server.close();
    localStorage = createLocalStorage(storageDir);
    setStorage(localStorage);
    server = createApp().listen(0);
    url = `http://127.0.0.1:${server.address().port}`;
    const res = await alice("GET", `/mailflow/resumes/${files.docx.id}/download`, null, { raw: true });
    assert.equal(res.status, 200);
    assert.equal(Buffer.from(await res.arrayBuffer()).length, files.docx.fileSize);
  });
});

describe("sending with attachments", () => {
  let template;
  let contacts;

  before(async () => {
    template = (await alice("GET", "/mailflow/templates")).templates.find((t) => t.name === "Hiring Outreach");
    contacts = [];
    for (const email of ["hr@google.com", "jobs@amazon.in", "careers@tcs.com"]) {
      contacts.push((await alice("POST", "/mailflow/contacts", { email, name: "HR" })).contact);
    }
  });

  test("one resume attached to one email, with the exact bytes", async () => {
    const r = await alice("POST", "/mailflow/emails/send", { templateId: template.id, contactIds: [contacts[0].id], resumeIds: [files.mern.id] });
    assert.equal(r.sent, 1);
    const msg = outbox.at(-1);
    assert.equal(msg.attachments.length, 1);
    assert.equal(msg.attachments[0].filename, "Khushant_MERN_Resume.pdf");
    assert.equal(msg.attachments[0].contentType, "application/pdf");
    assert.ok(Buffer.from(msg.attachments[0].content).equals(pdf("one")));
    assert.ok(!JSON.stringify(msg).includes("resumes/")); // no storage keys or URLs in the email
  });

  test("bulk send: every recipient gets every attachment, duplicates removed", async () => {
    const before = outbox.length;
    const r = await alice("POST", "/mailflow/emails/send", {
      templateId: template.id,
      contactIds: [contacts[1].id, contacts[2].id],
      resumeIds: [files.mern.id, files.docx.id, files.mern.id],
    });
    assert.equal(r.sent, 2);
    assert.equal(r.attachments.length, 2);
    const sent = outbox.slice(before);
    assert.equal(sent.length, 2);
    for (const m of sent) {
      assert.deepEqual(m.attachments.map((a) => a.filename).sort(), ["Full_Stack.docx", "Khushant_MERN_Resume.pdf"]);
    }
  });

  test("history records attachment metadata", async () => {
    const h = await alice("GET", `/mailflow/emails/history?contactId=${contacts[1].id}`);
    assert.deepEqual(
      h.history[0].attachments.map((a) => [a.fileName, a.fileType, typeof a.fileSize, String(a.resumeId).length]),
      [["Khushant_MERN_Resume.pdf", "pdf", "number", 24], ["Full_Stack.docx", "docx", "number", 24]],
    );
    const stats = await alice("GET", "/mailflow/emails/stats");
    assert.ok(stats.stats.recent[0].attachments.length >= 1);
  });

  test("limits are checked before anything is sent", async () => {
    const before = outbox.length;
    const tooMany = await alice("POST", "/mailflow/emails/send", {
      templateId: template.id, contactIds: [contacts[0].id], resumeIds: [files.mern.id, files.docx.id, files.doc.id, files.frontend.id],
    });
    assert.equal(tooMany.status, 400);
    assert.equal(outbox.length, before);
  });

  test("a file missing from storage stops the whole send", async () => {
    const extra = (await alice("POST", "/mailflow/resumes/upload", form([["Vanishing.pdf", pdf("vanish")]]))).uploaded[0];
    const doc = await Resume.findById(extra.id);
    await localStorage.delete(doc.storageKey);
    const before = outbox.length;
    const r = await alice("POST", "/mailflow/emails/send", {
      templateId: template.id, contactIds: [contacts[0].id, contacts[1].id], resumeIds: [files.mern.id, extra.id],
    });
    assert.equal(r.status, 410);
    assert.match(r.message, /Vanishing\.pdf.*missing/);
    assert.equal(outbox.length, before);
    await Resume.deleteOne({ _id: extra.id });
  });

  test("a tampered file is refused", async () => {
    const extra = (await alice("POST", "/mailflow/resumes/upload", form([["Tampered.pdf", pdf("tamper")]]))).uploaded[0];
    const doc = await Resume.findById(extra.id);
    fs.writeFileSync(path.join(storageDir, doc.storageKey), pdf("other content"));
    const r = await alice("POST", "/mailflow/emails/send", { templateId: template.id, contactIds: [contacts[0].id], resumeIds: [extra.id] });
    assert.equal(r.status, 409);
    await alice("DELETE", `/mailflow/resumes/${extra.id}`);
  });

  test("sending without attachments is unchanged", async () => {
    const before = outbox.length;
    const c = (await alice("POST", "/mailflow/contacts", { email: "plain@zeta.io" })).contact;
    const r = await alice("POST", "/mailflow/emails/send", { templateId: template.id, contactIds: [c.id] });
    assert.equal(r.sent, 1);
    assert.equal(outbox.at(-1).attachments, undefined);
    assert.equal(outbox.length, before + 1);
  });
});

describe("scheduled emails with attachments", () => {
  let template;
  let contact;
  const due = () => new Date(Date.now() + 3600e3).toISOString();
  const makeDue = (ids) => ScheduledEmail.updateMany({ _id: { $in: ids } }, { scheduledAt: new Date(Date.now() - 1000) });

  before(async () => {
    template = (await alice("GET", "/mailflow/templates")).templates[0];
    contact = (await alice("POST", "/mailflow/contacts", { email: "talent@infosys.co.in" })).contact;
  });

  test("resume ids are saved, shown, and the files go out when the job runs", async () => {
    const r = await alice("POST", "/mailflow/schedules", { templateId: template.id, contactIds: [contact.id], resumeIds: [files.mern.id, files.doc.id], scheduledAt: due() });
    assert.equal(r.status, 201);
    const s = r.schedules[0];
    assert.deepEqual(s.resumeIds.sort(), [files.mern.id, files.doc.id].sort());
    assert.deepEqual(s.attachments.map((a) => a.fileName).sort(), ["Khushant_MERN_Resume.pdf", "Legacy.doc"]);

    // Pending schedule protects the resume from deletion.
    const del = await alice("DELETE", `/mailflow/resumes/${files.doc.id}`);
    assert.equal(del.status, 409);
    assert.match(del.message, /scheduled email/);

    await makeDue([s.id]);
    const before = outbox.length;
    const run = await processDue({ delayMs: 0 });
    assert.equal(run.Sent, 1);
    const msg = outbox[before];
    assert.deepEqual(msg.attachments.map((a) => a.filename).sort(), ["Khushant_MERN_Resume.pdf", "Legacy.doc"]);
    const h = await alice("GET", `/mailflow/emails/history?contactId=${contact.id}`);
    assert.equal(h.history[0].source, "scheduled");
    assert.equal(h.history[0].attachments.length, 2);
  });

  test("several schedules in one run share one download per file", async () => {
    let reads = 0;
    const counting = { ...localStorage, driver: "local", getBuffer: (k) => (reads++, localStorage.getBuffer(k)) };
    setStorage(counting);
    const others = [];
    for (const e of ["a@b1.com", "a@b2.com", "a@b3.com"]) others.push((await alice("POST", "/mailflow/contacts", { email: e })).contact.id);
    const r = await alice("POST", "/mailflow/schedules", { templateId: template.id, contactIds: others, resumeIds: [files.mern.id], scheduledAt: due() });
    await makeDue(r.schedules.map((s) => s.id));
    const run = await processDue({ delayMs: 0 });
    assert.equal(run.Sent, 3);
    assert.equal(reads, 1);
    setStorage(localStorage);
  });

  test("a file that disappears before the job runs fails the job instead of sending without it", async () => {
    const extra = (await alice("POST", "/mailflow/resumes/upload", form([["Gone.pdf", pdf("gone")]]))).uploaded[0];
    const r = await alice("POST", "/mailflow/schedules", { templateId: template.id, contactIds: [contact.id], resumeIds: [extra.id], scheduledAt: due() });
    await localStorage.delete((await Resume.findById(extra.id)).storageKey);
    await makeDue([r.schedules[0].id]);
    const before = outbox.length;
    const run = await processDue({ delayMs: 0 });
    assert.equal(run.Failed, 1);
    assert.equal(outbox.length, before);
    const s = await ScheduledEmail.findById(r.schedules[0].id);
    assert.equal(s.status, "Failed");
    assert.match(s.errorMessage, /^Not sent: "Gone\.pdf" is missing/);
    await Resume.deleteOne({ _id: extra.id });
  });

  test("a deleted resume record also fails the job", async () => {
    const extra = (await alice("POST", "/mailflow/resumes/upload", form([["Removed.pdf", pdf("removed")]]))).uploaded[0];
    const r = await alice("POST", "/mailflow/schedules", { templateId: template.id, contactIds: [contact.id], resumeIds: [extra.id], scheduledAt: due() });
    await Resume.deleteOne({ _id: extra.id }); // bypasses the API guard on purpose
    const list = await alice("GET", "/mailflow/schedules");
    assert.equal(list.schedules.find((x) => x.id === r.schedules[0].id).attachments[0].missing, true);
    await makeDue([r.schedules[0].id]);
    assert.equal((await processDue({ delayMs: 0 })).Failed, 1);
    assert.match((await ScheduledEmail.findById(r.schedules[0].id)).errorMessage, /no longer in your Resume Library/);
  });

  test("a storage outage defers the job, then fails it after 3 attempts", async () => {
    const r = await alice("POST", "/mailflow/schedules", { templateId: template.id, contactIds: [contact.id], resumeIds: [files.frontend.id], scheduledAt: due() });
    const id = r.schedules[0].id;
    setStorage({ ...localStorage, driver: "local", getBuffer: async () => { throw new Error("ECONNRESET"); } });
    for (let attempt = 1; attempt <= 3; attempt++) {
      await makeDue([id]);
      const run = await processDue({ delayMs: 0 });
      const s = await ScheduledEmail.findById(id);
      if (attempt < 3) {
        assert.equal(run.Deferred, 1);
        assert.equal(s.status, "Pending");
        assert.ok(s.scheduledAt > new Date());
      } else {
        assert.equal(run.Failed, 1);
        assert.equal(s.status, "Failed");
      }
    }
    setStorage(localStorage);
  });

  test("send-now on a schedule attaches the files too", async () => {
    const r = await alice("POST", "/mailflow/schedules", { templateId: template.id, contactIds: [contact.id], resumeIds: [files.docx.id], scheduledAt: due() });
    const before = outbox.length;
    const s = await alice("POST", `/mailflow/schedules/${r.schedules[0].id}/send-now`);
    assert.equal(s.schedule.status, "Sent");
    assert.equal(outbox[before].attachments[0].filename, "Full_Stack.docx");
  });

  test("once schedules are resolved the resume can be deleted; history keeps the metadata", async () => {
    const r = await alice("POST", "/mailflow/schedules", { templateId: template.id, contactIds: [contact.id], resumeIds: [files.doc.id], scheduledAt: due() });
    assert.equal((await alice("DELETE", `/mailflow/resumes/${files.doc.id}`)).status, 409);
    await alice("PATCH", `/mailflow/schedules/${r.schedules[0].id}/cancel`);
    assert.equal((await alice("DELETE", `/mailflow/resumes/${files.doc.id}`)).status, 200);
    assert.equal((await alice("GET", `/mailflow/resumes/${files.doc.id}`)).status, 404);
    const doc = await Resume.findById(files.doc.id);
    assert.equal(doc, null);
    const h = await alice("GET", `/mailflow/emails/history?contactId=${contact.id}`);
    assert.ok(h.history.some((x) => x.attachments.some((a) => a.fileName === "Legacy.doc")));
    const sched = await alice("POST", "/mailflow/schedules", { templateId: template.id, contactIds: [contact.id], resumeIds: [files.doc.id], scheduledAt: due() });
    assert.equal(sched.status, 404);
  });
});

describe("S3 driver against an S3-compatible server", () => {
  // Minimal path-style S3 endpoint: enough of the protocol for PUT/GET/HEAD/DELETE object.
  const objects = new Map();
  let s3Server;
  let s3;

  before(async () => {
    s3Server = http.createServer(async (req, res) => {
      const key = decodeURIComponent(new URL(req.url, "http://x").pathname.replace(/^\/test-bucket\//, ""));
      if (req.method === "PUT") {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        objects.set(key, { body: Buffer.concat(chunks), type: req.headers["content-type"], auth: req.headers.authorization });
        res.writeHead(200, { ETag: '"etag"' }).end();
      } else if (req.method === "GET" || req.method === "HEAD") {
        const obj = objects.get(key);
        if (!obj) {
          res.writeHead(404, { "Content-Type": "application/xml" });
          return res.end(req.method === "GET" ? "<Error><Code>NoSuchKey</Code><Message>missing</Message></Error>" : undefined);
        }
        res.writeHead(200, { "Content-Type": obj.type, "Content-Length": obj.body.length, ETag: '"etag"' });
        res.end(req.method === "GET" ? obj.body : undefined);
      } else if (req.method === "DELETE") {
        objects.delete(key);
        res.writeHead(204).end();
      } else res.writeHead(405).end();
    });
    await new Promise((r) => s3Server.listen(0, r));
    s3 = createS3Storage({
      S3_BUCKET: "test-bucket",
      S3_REGION: "us-east-1",
      S3_ENDPOINT: `http://127.0.0.1:${s3Server.address().port}`,
      S3_FORCE_PATH_STYLE: true,
      S3_ACCESS_KEY_ID: "test-key",
      S3_SECRET_ACCESS_KEY: "test-secret",
    });
  });

  after(() => {
    s3Server.close();
    setStorage(localStorage);
  });

  test("driver: put / get / exists / delete, signed requests, missing objects", async () => {
    const tmp = path.join(os.tmpdir(), `s3-${randomBytes(4).toString("hex")}`);
    const body = pdf("s3");
    fs.writeFileSync(tmp, body);
    await s3.put("resumes/u/a.pdf", tmp, { contentType: "application/pdf", size: body.length });
    fs.rmSync(tmp);
    assert.ok(objects.get("resumes/u/a.pdf").body.equals(body));
    assert.match(objects.get("resumes/u/a.pdf").auth, /^AWS4-HMAC-SHA256 Credential=test-key\//);
    assert.ok((await s3.getBuffer("resumes/u/a.pdf")).equals(body));
    assert.equal(await s3.exists("resumes/u/a.pdf"), true);
    await s3.delete("resumes/u/a.pdf");
    assert.equal(await s3.exists("resumes/u/a.pdf"), false);
    await assert.rejects(() => s3.getBuffer("resumes/u/a.pdf"), { name: "Error", message: "File not found in storage" });
  });

  test("full flow on S3: upload, download, attach, delete", async () => {
    setStorage(s3);
    const up = await alice("POST", "/mailflow/resumes/upload", form([["S3 Resume.pdf", pdf("s3-flow")]]));
    assert.equal(up.status, 201);
    const id = up.uploaded[0].id;
    const key = (await Resume.findById(id)).storageKey;
    assert.ok(objects.has(key));
    const dl = await alice("GET", `/mailflow/resumes/${id}/download`, null, { raw: true });
    assert.ok(Buffer.from(await dl.arrayBuffer()).equals(pdf("s3-flow")));

    const t = (await alice("GET", "/mailflow/templates")).templates[0];
    const c = (await alice("POST", "/mailflow/contacts", { email: "s3@acme.io" })).contact;
    const before = outbox.length;
    await alice("POST", "/mailflow/emails/send", { templateId: t.id, contactIds: [c.id], resumeIds: [id] });
    assert.equal(outbox[before].attachments[0].filename, "S3_Resume.pdf");

    assert.equal((await alice("DELETE", `/mailflow/resumes/${id}`)).status, 200);
    assert.ok(!objects.has(key));
  });
});
