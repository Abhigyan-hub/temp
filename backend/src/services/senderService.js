import nodemailer from "nodemailer";
import mongoose from "mongoose";
import { EmailAccount } from "../models/EmailAccount.js";
import { AppError } from "../utils/AppError.js";
import { decryptSecret } from "../utils/crypto.js";
import { assertPublicHost } from "../utils/netGuard.js";
import { isDryRun, senderNameFor, systemSender } from "./emailService.js";

/** Builds the transport for a user's own account. Replaced by tests. */
let transportFactory = (account, password) =>
  isDryRun()
    ? nodemailer.createTransport({ jsonTransport: true })
    : nodemailer.createTransport({
        host: account.smtpHost,
        port: account.smtpPort,
        secure: account.smtpSecurity === "ssl",
        requireTLS: account.smtpSecurity === "starttls",
        auth: { user: account.smtpUsername, pass: password },
        connectionTimeout: 15000,
        greetingTimeout: 15000,
        socketTimeout: 60000,
      });

export function setCustomTransportFactory(factory) {
  transportFactory = factory;
}

function decryptPassword(account) {
  try {
    return decryptSecret(account.passwordEncrypted);
  } catch (err) {
    if (err instanceof AppError) throw err;
    // Wrong key or damaged value. The details stay out of logs and responses.
    throw new AppError(500, `The saved password for ${account.senderEmail} can't be read. Enter it again in Email Accounts.`);
  }
}

export function customSender(user, account) {
  return {
    kind: "custom",
    accountId: account._id,
    fromEmail: account.senderEmail,
    fromName: account.senderName || senderNameFor(user),
    replyTo: account.replyTo || "",
    transport: transportFactory(account, decryptPassword(account)),
    label: "The mail server",
  };
}

const findAccount = (userId, id) => EmailAccount.findOne({ _id: id, userId }).select("+passwordEncrypted");

/**
 * The sender for an email. `choice`: "system", an account id, or empty for the user's sending mode.
 * A problem with a custom account is an error: mail never silently goes out from the system account.
 */
export async function resolveSender(user, choice) {
  if (choice === "system") return systemSender(user);
  if (choice) {
    if (!mongoose.isValidObjectId(choice)) throw new AppError(400, "Invalid email account");
    const account = await findAccount(user._id, choice);
    if (!account) throw new AppError(404, "That email account no longer exists. Choose another sender.");
    await assertPublicHost(account.smtpHost);
    return customSender(user, account);
  }
  if ((user.settings?.sendingMode ?? "system") === "system") return systemSender(user);

  const account = await EmailAccount.findOne({ userId: user._id, isDefault: true }).select("+passwordEncrypted");
  if (!account) {
    throw new AppError(400, "Custom email mode is on but no default account is set. Add one in Email Accounts or switch to the system account.");
  }
  await assertPublicHost(account.smtpHost);
  return customSender(user, account);
}

/** "system" | account id, as stored on campaigns and schedules, for re-resolving later. */
export const senderChoiceOf = (doc) => (doc?.usesSystem ? "system" : doc?.emailAccountId ? String(doc.emailAccountId) : undefined);
