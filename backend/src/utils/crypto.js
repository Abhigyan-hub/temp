import crypto from "node:crypto";
import { env } from "../config/env.js";
import { AppError } from "./AppError.js";

const VERSION = "v1";

function key() {
  if (!env.CREDENTIAL_ENCRYPTION_KEY) {
    throw new AppError(503, "Custom email accounts aren't available: CREDENTIAL_ENCRYPTION_KEY is not set on the server.");
  }
  return Buffer.from(env.CREDENTIAL_ENCRYPTION_KEY, "hex");
}

export const encryptionConfigured = () => !!env.CREDENTIAL_ENCRYPTION_KEY;

/** AES-256-GCM. Output: v1.<iv>.<auth tag>.<ciphertext>, base64url. */
export function encryptSecret(plain, secretKey = key()) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", secretKey, iv);
  const data = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  return [VERSION, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), data.toString("base64url")].join(".");
}

/** Throws if the value was tampered with or encrypted under a different key. */
export function decryptSecret(stored, secretKey = key()) {
  const [version, iv, tag, data] = String(stored).split(".");
  if (version !== VERSION || !iv || !tag || data === undefined) throw new Error("Unrecognised credential format");
  const decipher = crypto.createDecipheriv("aes-256-gcm", secretKey, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
}
