// Classification of raw messages: no database, no network.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { simpleParser } from "mailparser";
import "dotenv/config";

process.env.NODE_ENV = "test";
process.env.EMAIL_TRANSPORT = "json";

const { classifyDeliveryReport, classifyMessage, parseDeliveryStatus, originalMessageId } = await import("../src/services/incoming/classify.js");

const dsn = ({ action = "failed", status = "5.1.1", diagnostic = "smtp; 550-5.1.1 The email account that you tried to reach does not exist.", recipient = "carears@company.com", original = "<abc123@gmail.com>", from = "Mail Delivery Subsystem <mailer-daemon@googlemail.com>", subject = "Delivery Status Notification (Failure)" } = {}) =>
  [
    `From: ${from}`,
    "To: me@gmail.com",
    `Subject: ${subject}`,
    "Message-ID: <dsn-1@mx.google.com>",
    `X-Failed-Recipients: ${recipient}`,
    'Content-Type: multipart/report; boundary="bbb"; report-type=delivery-status',
    "",
    "--bbb",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    "Address not found",
    "",
    "--bbb",
    "Content-Type: message/delivery-status",
    "",
    "Reporting-MTA: dns; googlemail.com",
    "Arrival-Date: Wed, 04 Nov 2026 10:00:00 -0800",
    "",
    `Final-Recipient: rfc822; ${recipient}`,
    `Action: ${action}`,
    `Status: ${status}`,
    "Remote-MTA: dns; mx.company.com",
    `Diagnostic-Code: ${diagnostic}`,
    "Last-Attempt-Date: Wed, 04 Nov 2026 10:00:01 -0800",
    "",
    "--bbb",
    "Content-Type: message/rfc822",
    "",
    "From: Me <me@gmail.com>",
    `To: ${recipient}`,
    "Subject: Application",
    `Message-ID: ${original}`,
    "",
    "Hello",
    "--bbb--",
    "",
  ].join("\r\n");

const plain = (headers, body = "Thanks, let's talk.") => [...headers, "Content-Type: text/plain", "", body, ""].join("\r\n");

describe("delivery status notifications", () => {
  test("Gmail-style hard bounce: structured fields and the original Message-ID", () => {
    const r = classifyMessage(dsn());
    assert.equal(r.classification, "hard_bounce");
    assert.equal(r.originalMessageId, "<abc123@gmail.com>");
    assert.equal(r.bounce.finalRecipient, "carears@company.com");
    assert.equal(r.bounce.status, "5.1.1");
    assert.equal(r.bounce.structured, true);
    assert.match(r.bounce.diagnostic, /does not exist/);
  });

  const cases = [
    ["bad domain 5.1.2 is hard", { status: "5.1.2" }, "hard_bounce"],
    ["unroutable 5.4.4 is hard", { status: "5.4.4" }, "hard_bounce"],
    ["mailbox full 5.2.2 is soft", { status: "5.2.2", diagnostic: "smtp; 552 mailbox full" }, "soft_bounce"],
    ["temporary 4.4.1 is soft", { status: "4.4.1", diagnostic: "smtp; 451 try later" }, "soft_bounce"],
    ["delayed action is soft", { action: "delayed", status: "4.4.7", diagnostic: "" }, "soft_bounce"],
    ["greylisting 4.7.1 is a temporary rejection", { status: "4.7.1", diagnostic: "smtp; 450 greylisted" }, "temporary_rejection"],
    ["spam policy 5.7.1 is rejected, not an invalid address", { status: "5.7.1", diagnostic: "smtp; 550 blocked as spam" }, "rejected"],
    ["generic 5.0.0 with user unknown is hard", { status: "5.0.0", diagnostic: "smtp; 550 user unknown" }, "hard_bounce"],
    ["generic 5.0.0 otherwise is rejected", { status: "5.0.0", diagnostic: "smtp; 550 refused" }, "rejected"],
  ];
  for (const [name, opts, expected] of cases) {
    test(name, () => assert.equal(classifyMessage(dsn(opts)).classification, expected));
  }

  test("base64-encoded status part", () => {
    const status = Buffer.from("Reporting-MTA: dns; x\r\n\r\nFinal-Recipient: rfc822; a@b.com\r\nAction: failed\r\nStatus: 5.1.1\r\n").toString("base64");
    const raw = [
      "From: postmaster@b.com",
      'Content-Type: multipart/report; boundary="z"; report-type=delivery-status',
      "",
      "--z",
      "Content-Type: message/delivery-status",
      "Content-Transfer-Encoding: base64",
      "",
      status,
      "--z--",
    ].join("\r\n");
    assert.equal(parseDeliveryStatus(raw).finalRecipient, "a@b.com");
    assert.equal(classifyMessage(raw).classification, "hard_bounce");
  });

  test("text/rfc822-headers variant still gives the original id", () => {
    const raw = dsn().replace("Content-Type: message/rfc822", "Content-Type: text/rfc822-headers");
    assert.equal(originalMessageId(raw), "<abc123@gmail.com>");
  });

  test("a mail server without a proper report: daemon sender plus failure text", () => {
    const raw = plain(["From: MAILER-DAEMON@old.host", "Subject: failure notice", "X-Failed-Recipients: gone@old.host", "Message-ID: <m1@old.host>"], "550 user unknown: gone@old.host");
    const r = classifyMessage(raw, { subject: "failure notice", text: "550 user unknown: gone@old.host" });
    assert.equal(r.classification, "hard_bounce");
    assert.equal(r.bounce.structured, false);
    assert.equal(r.bounce.finalRecipient, "gone@old.host");
  });

  test("classifyDeliveryReport never makes a 4xx permanent", () => {
    for (const status of ["4.0.0", "4.2.2", "4.4.1", "4.1.1"]) assert.notEqual(classifyDeliveryReport({ action: "failed", status, diagnostic: "user unknown" }), "hard_bounce", status);
  });
});

describe("replies are judged by headers, not subject lines", () => {
  test("a person writing the subject 'Delivery Status Notification (Failure)' is still a person", () => {
    const raw = plain(["From: Rahul <rahul@acme.io>", "Subject: Delivery Status Notification (Failure)", "In-Reply-To: <abc123@gmail.com>", "Message-ID: <r1@acme.io>"]);
    assert.equal(classifyMessage(raw, { subject: "Delivery Status Notification (Failure)" }).classification, "human_reply");
  });

  test("a person writing the subject 'Out of office' with no automatic headers is still a person", () => {
    const raw = plain(["From: a@b.com", "Subject: Out of office party?", "Message-ID: <r2@b.com>"]);
    assert.equal(classifyMessage(raw, { subject: "Out of office party?" }).classification, "human_reply");
  });

  test("human reply exposes threading headers", () => {
    const raw = plain(["From: a@b.com", "Subject: Re: Hi", "In-Reply-To: <x@y>", "References: <w@y> <x@y>", "Message-ID: <r3@b.com>"]);
    const r = classifyMessage(raw);
    assert.equal(r.classification, "human_reply");
    assert.equal(r.inReplyTo, "<x@y>");
    assert.deepEqual(r.references, ["<w@y>", "<x@y>"]);
    assert.equal(r.messageId, "<r3@b.com>");
  });

  const auto = [
    ["Auto-Submitted: auto-replied", "auto_reply"],
    ["X-Autoreply: yes", "auto_reply"],
    ["X-Autorespond: yes", "auto_reply"],
    ["Precedence: auto_reply", "auto_reply"],
  ];
  for (const [header, expected] of auto) {
    test(`${header} is automatic, not a bounce`, () => {
      assert.equal(classifyMessage(plain(["From: a@b.com", "Subject: Thanks", header, "Message-ID: <a@b>"])).classification, expected);
    });
  }

  test("Auto-Submitted: no is a person", () => {
    assert.equal(classifyMessage(plain(["From: a@b.com", "Auto-Submitted: no", "Message-ID: <a2@b>"])).classification, "human_reply");
  });

  test("an automatic message about being away is out of office", () => {
    const raw = plain(["From: a@b.com", "Subject: Automatic reply: Out of Office", "Auto-Submitted: auto-replied", "Message-ID: <a3@b>"]);
    assert.equal(classifyMessage(raw, { subject: "Automatic reply: Out of Office" }).classification, "out_of_office");
  });

  test("spam complaint report", () => {
    const raw = ['From: fbl@x.com', 'Content-Type: multipart/report; boundary="q"; report-type=feedback-report', "Message-ID: <c@x>", "", "--q--"].join("\r\n");
    assert.equal(classifyMessage(raw).classification, "complaint");
  });

  test("real parser handles the same bounce message", async () => {
    const mail = await simpleParser(Buffer.from(dsn()));
    assert.equal(mail.subject, "Delivery Status Notification (Failure)");
    assert.match(mail.text ?? "", /Address not found/);
  });
});
