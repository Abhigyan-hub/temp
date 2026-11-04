import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(5000),
  MONGODB_URI: z.string().min(1, "MONGODB_URI is required"),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  JWT_EXPIRES_IN: z.string().default("7d"),
  GMAIL_USER: z.string().email("GMAIL_USER must be an email address"),
  GMAIL_PASS: z.string().min(1, "GMAIL_PASS (Gmail App Password) is required"),
  GMAIL_HOST: z.string().default("smtp.gmail.com"),
  GMAIL_PORT: z.coerce.number().int().positive().default(465),
  GMAIL_SECURE: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  // Encrypts users' own SMTP passwords. 32 random bytes as hex:
  //   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  // Without it custom email accounts are unavailable; the system account keeps working.
  CREDENTIAL_ENCRYPTION_KEY: z
    .string()
    .regex(/^([0-9a-fA-F]{64})?$/, "CREDENTIAL_ENCRYPTION_KEY must be 64 hex characters (32 bytes)")
    .default(""),
  // Reading replies and bounce notifications (IMAP, read-only).
  INBOX_SYNC_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  INBOX_SYNC_INTERVAL_MIN: z.coerce.number().int().min(1).max(60).default(5),
  // How far back the first sync of a mailbox looks.
  INBOX_SYNC_DAYS: z.coerce.number().int().min(1).max(90).default(14),
  GMAIL_IMAP_HOST: z.string().default("imap.gmail.com"),
  GMAIL_IMAP_PORT: z.coerce.number().int().positive().default(993),
  FRONTEND_URL: z.string().url("FRONTEND_URL must be a URL"),
  // Extra origins allowed by CORS, comma separated (e.g. Vercel preview URLs).
  CORS_ORIGINS: z.string().default(""),
  // "lax" when the frontend proxies /mailflow on the same site, "none" when it calls the API cross-site.
  COOKIE_SAMESITE: z.enum(["lax", "strict", "none"]).default("lax"),
  // Comma separated list of emails allowed to register. Empty = open registration.
  ALLOWED_SIGNUP_EMAILS: z.string().default(""),
  SEND_DELAY_MS: z.coerce.number().int().min(0).default(1500),
  MAX_RECIPIENTS_PER_SEND: z.coerce.number().int().positive().default(50),
  DAILY_SEND_LIMIT: z.coerce.number().int().positive().default(400),
  SCHEDULER_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  SCHEDULER_BATCH_SIZE: z.coerce.number().int().positive().default(20),
  // "smtp" uses Gmail. "json" builds messages without sending (tests / local dry runs).
  EMAIL_TRANSPORT: z.enum(["smtp", "json"]).default("smtp"),

  // ---- Resume storage ----
  // "s3": any S3-compatible bucket (AWS S3, Cloudflare R2, Backblaze B2, MinIO). Required in production.
  // "local": files on this machine's disk — development/tests only (Render's disk is wiped on deploy).
  // Empty: s3 when S3_BUCKET is set, otherwise local outside production.
  STORAGE_DRIVER: z.enum(["s3", "local", ""]).default(""),
  S3_BUCKET: z.string().default(""),
  S3_REGION: z.string().default("auto"),
  // Leave empty for AWS. R2: https://<account-id>.r2.cloudflarestorage.com
  S3_ENDPOINT: z.string().default(""),
  S3_ACCESS_KEY_ID: z.string().default(""),
  S3_SECRET_ACCESS_KEY: z.string().default(""),
  S3_FORCE_PATH_STYLE: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  LOCAL_STORAGE_DIR: z.string().default("storage"),
  RESUME_MAX_MB: z.coerce.number().positive().max(20).default(5),
  RESUME_MAX_FILES_PER_UPLOAD: z.coerce.number().int().positive().max(20).default(10),
  RESUME_MAX_PER_USER: z.coerce.number().int().positive().default(100),
  ATTACHMENT_MAX_COUNT: z.coerce.number().int().positive().max(10).default(5),
  // Gmail's 25 MB limit includes ~33% base64 overhead, so keep raw attachments well under it.
  ATTACHMENT_MAX_TOTAL_MB: z.coerce.number().positive().max(18).default(15),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("❌ Invalid environment configuration:");
  for (const issue of parsed.error.issues) {
    console.error(`   - ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

const raw = parsed.data;
const list = (s) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

export const env = {
  ...raw,
  isProd: raw.NODE_ENV === "production",
  corsOrigins: [raw.FRONTEND_URL.replace(/\/$/, ""), ...list(raw.CORS_ORIGINS)],
  allowedSignupEmails: list(raw.ALLOWED_SIGNUP_EMAILS).map((e) => e.toLowerCase()),
  resumeMaxBytes: Math.round(raw.RESUME_MAX_MB * 1024 * 1024),
  attachmentMaxTotalBytes: Math.round(raw.ATTACHMENT_MAX_TOTAL_MB * 1024 * 1024),
};
