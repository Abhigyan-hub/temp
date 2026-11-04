import { z } from "zod";
import { env } from "../config/env.js";
import { EmailAccount } from "../models/EmailAccount.js";
import { EmailCampaign } from "../models/EmailCampaign.js";
import { ScheduledEmail } from "../models/ScheduledEmail.js";
import { classifySmtpFailure, sendMail, verifyTransport } from "../services/emailService.js";
import { customSender } from "../services/senderService.js";
import { AppError, notFound } from "../utils/AppError.js";
import { encryptionConfigured, encryptSecret } from "../utils/crypto.js";
import { assertPublicHost } from "../utils/netGuard.js";
import { emailField } from "../utils/validators.js";

const hostname = z
  .string({ error: "SMTP host is required" })
  .trim()
  .toLowerCase()
  .regex(/^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, "Enter a host name like smtp.example.com");
const SMTP_PORTS = [25, 465, 587, 2465, 2525, 2587];
const port = z.coerce.number().int().refine((p) => SMTP_PORTS.includes(p), `SMTP port must be one of ${SMTP_PORTS.join(", ")}`);
const imapPort = z.coerce.number().int().refine((p) => p === 993, "IMAP needs port 993 (implicit TLS)");
const replyTo = z.union([z.literal(""), emailField]);

const SECURITY_MISMATCH = "Port 465 uses SSL/TLS and port 587 uses STARTTLS. Check that the port and security setting match.";
const securityMismatch = (security, smtpPort) => (security === "ssl" && smtpPort === 587) || (security === "starttls" && smtpPort === 465);

const fields = {
  label: z.string().trim().max(100).optional().default(""),
  senderName: z.string().trim().max(100).optional().default(""),
  senderEmail: emailField,
  replyTo: replyTo.optional().default(""),
  smtpHost: hostname,
  smtpPort: port,
  smtpSecurity: z.enum(["ssl", "starttls"]),
  smtpUsername: z.string({ error: "SMTP username is required" }).trim().min(1, "SMTP username is required").max(254),
  imapEnabled: z.boolean().optional().default(false),
  imapHost: z.union([z.literal(""), hostname]).optional().default(""),
  imapPort: imapPort.optional().default(993),
};

const password = z.string({ error: "Password is required" }).min(1, "Password is required").max(500);

export const schemas = {
  create: z
    .object({ ...fields, password })
    .refine((v) => !securityMismatch(v.smtpSecurity, v.smtpPort), { message: SECURITY_MISMATCH, path: ["smtpPort"] })
    .refine((v) => !v.imapEnabled || v.imapHost, { message: "Enter the IMAP host to read replies", path: ["imapHost"] }),
  update: z.object({
    label: z.string().trim().max(100),
    senderName: z.string().trim().max(100),
    senderEmail: emailField,
    replyTo,
    smtpHost: hostname,
    smtpPort: port,
    smtpSecurity: z.enum(["ssl", "starttls"]),
    smtpUsername: z.string().trim().min(1, "SMTP username is required").max(254),
    imapEnabled: z.boolean(),
    imapHost: z.union([z.literal(""), hostname]),
    imapPort,
    password,
  }).partial(),
};

const own = (req) => EmailAccount.findOne({ _id: req.params.id, userId: req.user._id });
const ownWithSecret = (req) => own(req).select("+passwordEncrypted");

export async function list(req, res) {
  const accounts = await EmailAccount.find({ userId: req.user._id }).sort({ createdAt: 1 });
  res.json({
    success: true,
    accounts,
    sendingMode: req.user.settings?.sendingMode ?? "system",
    // Only ever the address: the system password stays in the server's environment.
    system: { senderEmail: env.GMAIL_USER, host: env.GMAIL_HOST, port: env.GMAIL_PORT, secure: env.GMAIL_SECURE },
    encryptionConfigured: encryptionConfigured(),
  });
}

export async function create(req, res) {
  const { password: plain, ...data } = req.body;
  await assertPublicHost(data.smtpHost);
  if (data.imapEnabled) await assertPublicHost(data.imapHost);
  const passwordEncrypted = encryptSecret(plain); // 503 with a clear message when no key is configured
  const isFirst = !(await EmailAccount.exists({ userId: req.user._id }));
  try {
    const account = await EmailAccount.create({ ...data, userId: req.user._id, passwordEncrypted, isDefault: isFirst });
    res.status(201).json({ success: true, account });
  } catch (err) {
    if (err?.code === 11000) throw new AppError(409, "You already saved this sender with the same username");
    throw err;
  }
}

export async function update(req, res) {
  const account = await ownWithSecret(req);
  if (!account) throw notFound("Email account");
  const { password: plain, ...data } = req.body;

  // A saved password must never be sendable to a different server or login without re-entering it.
  const movesCredentials =
    (data.smtpHost && data.smtpHost !== account.smtpHost) ||
    (data.smtpUsername && data.smtpUsername !== account.smtpUsername) ||
    (data.imapHost && data.imapHost !== account.imapHost);
  if (movesCredentials && !plain) {
    throw new AppError(400, "Enter the password again when changing the server or username");
  }

  if (data.smtpHost) await assertPublicHost(data.smtpHost);
  if (data.imapHost) await assertPublicHost(data.imapHost);
  account.set(data);
  if (securityMismatch(account.smtpSecurity, account.smtpPort)) throw new AppError(400, SECURITY_MISMATCH);
  if (account.imapEnabled && !account.imapHost) throw new AppError(400, "Enter the IMAP host to read replies");
  if (plain) account.passwordEncrypted = encryptSecret(plain);
  // Connection details changed, so the last test no longer says anything.
  if (plain || movesCredentials || data.smtpPort || data.smtpSecurity) {
    account.lastTestAt = null;
    account.lastTestOk = null;
    account.lastTestError = "";
  }
  await account.save();
  res.json({ success: true, account: await own(req) });
}

export async function remove(req, res) {
  const userId = req.user._id;
  const account = await own(req);
  if (!account) throw notFound("Email account");

  const pending = await ScheduledEmail.countDocuments({ userId, emailAccountId: account._id, status: { $in: ["Pending", "Processing"] } });
  const running = await EmailCampaign.exists({ userId, emailAccountId: account._id, status: { $in: ["Queued", "Running"] } });
  if (pending || running) {
    throw new AppError(409, pending ? `${pending} scheduled email${pending === 1 ? " uses" : "s use"} this account. Cancel them or wait until they're sent.` : "A send using this account is in progress.");
  }

  await EmailAccount.deleteOne({ _id: account._id });
  // The oldest remaining account takes over as default; with none left, custom mode has no account.
  if (account.isDefault) {
    const next = await EmailAccount.findOne({ userId }).sort({ createdAt: 1 });
    if (next) await EmailAccount.updateOne({ _id: next._id }, { $set: { isDefault: true } });
  }
  res.json({ success: true });
}

export async function setDefault(req, res) {
  const account = await own(req);
  if (!account) throw notFound("Email account");
  await EmailAccount.updateMany({ userId: req.user._id, isDefault: true }, { $set: { isDefault: false } });
  account.isDefault = true;
  await account.save();
  res.json({ success: true, account });
}

function testFailure(err) {
  const { kind } = classifySmtpFailure(err);
  if (kind === "auth") return "The server rejected the login. Check the username and App Password.";
  if (kind === "network") return "Could not connect. Check the host, port and security setting.";
  if (/wrong version number|ssl3|tls/i.test(err?.message ?? "")) return "TLS failed. Port 465 uses SSL/TLS and port 587 uses STARTTLS; check they match.";
  return "The server refused the connection test.";
}

/** Log in to the SMTP server without sending anything. */
export async function test(req, res) {
  const account = await ownWithSecret(req);
  if (!account) throw notFound("Email account");
  await assertPublicHost(account.smtpHost);
  const sender = customSender(req.user, account);
  let error = "";
  try {
    await sender.transport.verify();
  } catch (err) {
    error = testFailure(err);
  }
  await EmailAccount.updateOne({ _id: account._id }, { $set: { lastTestAt: new Date(), lastTestOk: !error, lastTestError: error } });
  if (error) throw new AppError(400, error);
  res.json({ success: true, message: "Connection OK: the server accepted the login." });
}

/** The system account's connection check. Reports the outcome only, never the credentials. */
export async function testSystem(_req, res) {
  try {
    await verifyTransport();
  } catch (err) {
    throw new AppError(400, testFailure(err));
  }
  res.json({ success: true, message: "Connection OK: the server accepted the login." });
}

/** Send one real test email from this account to the signed-in user's own address. */
export async function testSend(req, res) {
  const account = await ownWithSecret(req);
  if (!account) throw notFound("Email account");
  await assertPublicHost(account.smtpHost);
  const sender = customSender(req.user, account);
  const result = await sendMail({
    to: req.user.email,
    subject: "MailFlow test email",
    text: `Hi ${req.user.name},\n\nThis is a test email from MailFlow, sent through ${account.senderEmail}. If you can read this, the account works.\n\n— MailFlow`,
    sender,
  });
  await EmailAccount.updateOne(
    { _id: account._id },
    { $set: { lastTestAt: new Date(), lastTestOk: result.success, lastTestError: result.success ? "" : result.error } },
  );
  if (!result.success) throw new AppError(400, result.error);
  res.json({ success: true, message: `Test email handed to the mail server for ${req.user.email}. Check that inbox.` });
}
