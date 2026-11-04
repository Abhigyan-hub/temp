# MailFlow — Running & Deploying

MailFlow is two apps in one repo:

| Part | Folder | Stack | Hosts on |
|---|---|---|---|
| Frontend | `/` | TanStack Start, React 19, Vite, Tailwind, Zustand | Vercel |
| API | `backend/` | Node 20+, Express 5, Mongoose, JWT, Nodemailer, node-cron | Render |
| Database | – | MongoDB | MongoDB Atlas |

The browser only ever talks to the frontend's own domain. Requests to `/api/*` are forwarded to the
Express API (by the Vite dev proxy locally, by a Vercel rewrite in production). This keeps the
`httpOnly` session cookie first-party, so no tokens are stored in `localStorage`.

---

## Local development

```bash
# 1. API
cd backend
cp .env.example .env        # fill in MONGODB_URI, JWT_SECRET, GMAIL_PASS
npm install
npm run dev                 # http://localhost:5000  (GET /api/health)

# 2. Frontend (new terminal, repo root)
npm install
npm run dev                 # http://localhost:8080  (proxies /api → :5000)
```

If port 8080 is busy Vite picks the next one; add that origin to `CORS_ORIGINS` in `backend/.env`
only if you call the API directly (not needed when using the proxy).

### Tests

```bash
cd backend
npm test
```

Runs the API, contact-data and Resume Library tests against separate `mailflow_test*` databases
(dropped afterwards) with a fake mail transport, so no email is sent. Resume storage runs on a temp
directory and on an in-process S3-compatible server. Covers auth, user isolation, contacts, import,
templates, sending/failures, scheduling, duplicate-claim races, restart recovery, password reset,
settings, resume upload/validation, attachments in bulk and scheduled sends.

> Don't run a second backend against the real database while testing scheduled emails: every
> backend instance runs the scheduler, and whichever claims a due job sends it with its own mail settings.

---

## Environment variables

### Backend (`backend/.env`, Render dashboard)

| Variable | Required | Description |
|---|---|---|
| `MONGODB_URI` | ✅ | Atlas connection string **including the database name**, e.g. `mongodb+srv://user:pass@cluster.mongodb.net/mailflow?retryWrites=true&w=majority` |
| `JWT_SECRET` | ✅ | ≥ 32 random characters. `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `GMAIL_USER` | ✅ | `wankhedekhushant57@gmail.com` |
| `GMAIL_PASS` | ✅ | 16-character Gmail **App Password** (Google Account → Security → 2-Step Verification → App passwords). Not your Gmail password. |
| `FRONTEND_URL` | ✅ | Public frontend URL, e.g. `https://mailflow.vercel.app`. Used for CORS and password-reset links. |
| `NODE_ENV` | | `production` on Render (hides error details, secure cookies) |
| `PORT` | | Render sets this automatically |
| `ALLOWED_SIGNUP_EMAILS` | | Comma-separated emails allowed to register. **Set this in production** — every account sends through your Gmail. |
| `CORS_ORIGINS` | | Extra allowed origins (comma-separated), e.g. Vercel preview URLs |
| `COOKIE_SAMESITE` | | `lax` (default, with proxy) or `none` (frontend calls API cross-site) |
| `JWT_EXPIRES_IN` | | Session length, default `7d` |
| `SEND_DELAY_MS` | | Pause between consecutive emails, default `1500` |
| `MAX_RECIPIENTS_PER_SEND` | | Per "Send now" request, default `50` |
| `DAILY_SEND_LIMIT` | | Rolling 24h cap per user, default `400` (Gmail allows ~500/day) |
| `SCHEDULER_ENABLED` | | `true` (default). Set `false` on extra instances if you only want one worker (safe either way). |
| `SCHEDULER_BATCH_SIZE` | | Max scheduled emails per minute per instance, default `20` |
| `EMAIL_TRANSPORT` | | `smtp` (default) or `json` for a dry run that sends nothing |
| `CREDENTIAL_ENCRYPTION_KEY` | for custom accounts | 64 hex characters. Encrypts users' SMTP passwords. See **Email accounts** below. |
| `GMAIL_HOST`, `GMAIL_PORT`, `GMAIL_SECURE` | | System SMTP server. Defaults: `smtp.gmail.com`, `465`, `true` |
| `INBOX_SYNC_ENABLED`, `INBOX_SYNC_INTERVAL_MIN`, `INBOX_SYNC_DAYS` | | Reading replies and bounces. Defaults: `true`, `5`, `14` (how far back the first check looks) |
| `GMAIL_IMAP_HOST`, `GMAIL_IMAP_PORT` | | System mailbox for reading. Defaults: `imap.gmail.com`, `993` |
| `STORAGE_DRIVER` | | `s3` in production (set in `render.yaml`); `local` for development |
| `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | ✅ in production | Private bucket for resume files — see **Resume storage** below |
| `S3_FORCE_PATH_STYLE` | | `true` for MinIO / some self-hosted servers |
| `RESUME_MAX_MB`, `RESUME_MAX_FILES_PER_UPLOAD`, `RESUME_MAX_PER_USER` | | Upload limits (5 MB, 10, 100) |
| `ATTACHMENT_MAX_COUNT`, `ATTACHMENT_MAX_TOTAL_MB` | | Per-email attachment limits (5 files, 15 MB) |

The server validates these on startup and exits with a clear message if something is missing.

### Frontend (Vercel project settings)

| Variable | Description |
|---|---|
| `BACKEND_URL` | Render API URL, e.g. `https://mailflow-api.onrender.com`. **Build-time**: redeploy after changing. |
| `VITE_API_URL` | Optional. Only if you want the browser to call the API cross-origin instead of proxying (then set backend `COOKIE_SAMESITE=none`). |

---

## Deploy

### 1. MongoDB Atlas
1. Create a database user with a strong password (read/write on the `mailflow` database).
2. Network Access → allow `0.0.0.0/0` (Render has no fixed outbound IPs on standard plans).
3. Copy the connection string and add `/mailflow` before the `?`.

### 2. Backend on Render
1. Push the repo to GitHub.
2. Render → **New → Blueprint** → select the repo. `render.yaml` creates `mailflow-api`
   (root dir `backend`, `npm ci --omit=dev`, `npm start`, health check `/api/health`).
3. Fill in the secret env vars: `MONGODB_URI`, `GMAIL_PASS`, `FRONTEND_URL`, `ALLOWED_SIGNUP_EMAILS`.
   `JWT_SECRET` is generated automatically.
4. Deploy and open `https://<service>.onrender.com/api/health` — expect `{"status":"ok","db":"connected"}`.
   The logs should show `✅ Gmail SMTP ready`.

> **Scheduler & free plan:** scheduled emails are sent by the API process every minute.
> Render's free plan sleeps after ~15 minutes idle; due emails would then only go out when the
> service next wakes (they are caught up on boot, not lost). Use the Starter plan for on-time delivery.

### 3. Frontend on Vercel
1. Vercel → **Add New Project** → import the repo (root directory: repo root).
2. Framework preset: **Other** (nitro detects Vercel automatically). Build command `npm run build`.
3. Environment variable: `BACKEND_URL=https://<service>.onrender.com`.
4. Deploy, then set `FRONTEND_URL` on Render to the final Vercel URL and redeploy the API.

### Production build commands

| | Command |
|---|---|
| Frontend | `npm run build` (output: `.vercel/output` on Vercel, `.output/` elsewhere) |
| Backend | `cd backend && npm ci --omit=dev && npm start` |

---

## Email accounts, replies and bounces

### Custom sender accounts
Users can send from their own SMTP accounts (Email Accounts page). Their passwords are encrypted
with AES-256-GCM using `CREDENTIAL_ENCRYPTION_KEY`, are never returned by any API, and are never logged.

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Put the result in `CREDENTIAL_ENCRYPTION_KEY` on Render (and in `backend/.env` locally). Keep a copy
somewhere safe and **don't change it**: saved passwords can't be read with a different key, and users
would have to enter them again. Without the key, custom accounts are unavailable and the system
account keeps working. In production, hosts that resolve to private network addresses are refused.

### Reading replies and bounces
SMTP only sends, so MailFlow reads incoming mail with **read-only IMAP polling** (every
`INBOX_SYNC_INTERVAL_MIN` minutes, default 5). Nothing is marked read, moved or deleted, and it uses
the same App Password as sending, so no Google Cloud project is needed. The system mailbox uses
`GMAIL_USER` / `GMAIL_PASS` with `GMAIL_IMAP_HOST`; custom accounts opt in per account.

| How a message is recognised | Evidence |
|---|---|
| Bounce | A delivery status report (`multipart/report`): `Action`, `Status`, `Diagnostic-Code` |
| Which email it belongs to | The returned copy's `Message-ID`, then `In-Reply-To` and `References`, then the failed recipient or the sender |
| Automatic reply | `Auto-Submitted`, `X-Autoreply`, `X-Autorespond`, `Precedence: auto_reply` |
| Real reply | None of the above, and tied to an email MailFlow sent |

Only messages tied to an email sent through MailFlow are stored. The rest of the inbox is ignored.
Set `INBOX_SYNC_ENABLED=false` to turn reading off. Render's free plan sleeps, so checks pause until it wakes.

"Sent" in MailFlow always means the mail server accepted the email, never that it reached the inbox.

Hard bounces are excluded from sending until the address is corrected or the status is changed by hand.
Soft bounces wait 24 hours and need a manual review after 3 in a row. Temporary rejections wait 1 hour.

### Live sending
Sends run as a background job on the API, with every step saved in MongoDB. The browser follows along
over Server-Sent Events (`/api/campaigns/:id/events`) and falls back to polling if a proxy drops the
stream. Closing the browser doesn't stop a send, and a send interrupted by a restart resumes within a
minute of the server coming back. The one recipient being sent to at the moment of a crash is marked
Failed, because it may or may not have gone out; only Retry re-sends it.

## Resume storage (Resume Library)

Resume files are kept in a **private S3-compatible bucket**; MongoDB only stores metadata
(name, category, size, content hash, storage key). The browser never sees a storage URL: previews,
downloads and email attachments are streamed through the authenticated API after an ownership check.

Render's filesystem is wiped on every deploy, so production refuses the `local` driver. Until the
bucket is configured, the Resume Library shows "Resume storage isn't set up" and the rest of the app
keeps working.

### Option A — Cloudflare R2 (recommended: 10 GB free, no egress fees)
1. Cloudflare dashboard → **R2** → Create bucket (e.g. `mailflow-resumes`). Leave public access **off**.
2. R2 → **Manage API tokens** → Create token with *Object Read & Write* on that bucket.
3. On Render set:
   `S3_BUCKET=mailflow-resumes`, `S3_REGION=auto`,
   `S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com`,
   `S3_ACCESS_KEY_ID=…`, `S3_SECRET_ACCESS_KEY=…`.

### Option B — AWS S3
1. Create a bucket with **Block all public access** enabled (the default).
2. Create an IAM user with this policy, and an access key for it:
   ```json
   { "Version": "2012-10-17", "Statement": [{ "Effect": "Allow",
     "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
     "Resource": "arn:aws:s3:::<bucket>/resumes/*" }] }
   ```
   (`HeadObject` is covered by `s3:GetObject`.)
3. On Render set `S3_BUCKET`, `S3_REGION` (e.g. `ap-south-1`), `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`; leave `S3_ENDPOINT` empty.

After deploying, `GET /api/resumes/status` (signed in) should report `"storage":{"configured":true,"driver":"s3"}`.

### Limits and checks
* PDF, DOCX and DOC only, identified by file content (not the extension). PDFs with JavaScript,
  launch actions or embedded files, and Word files with macros, are rejected.
* 5 MB per file, 10 files per upload, 100 resumes per user (`RESUME_*` variables).
* Duplicate files (same content) are detected per user.
* Up to 5 attachments / 15 MB per email (`ATTACHMENT_*`). Every attachment is downloaded and its
  size + SHA-256 verified **before** the first email of a send goes out.
* A resume attached to a pending scheduled email can't be deleted. If a file disappears anyway,
  the scheduled email is marked Failed ("Not sent: …") instead of going out without it. Storage
  outages are retried 3 times, 5 minutes apart.

### Local development
Without S3 variables the backend stores files in `backend/storage/` (git-ignored).
To test against a real bucket locally, put the `S3_*` variables in `backend/.env`.

## How scheduling works

* Each scheduled email is one `ScheduledEmail` document (one per recipient), stored in UTC.
  The browser converts the date/time you pick from your local time before sending it.
* Every minute (and immediately on boot) each API instance **atomically claims** due documents
  (`Pending → Processing`) with `findOneAndUpdate`, so two instances can never send the same email.
* Crash safety: if a job is stuck in `Processing` for 10 minutes it is put back to `Pending` if it
  never reached Gmail, or marked `Failed` (with a note to check Gmail's Sent folder) if it might have —
  MailFlow never risks a duplicate send.
* Blocking/deleting a contact or deleting a template cancels its pending schedules.

## Security notes

* Passwords hashed with bcrypt (12 rounds); sessions are JWTs in an `httpOnly`, `SameSite` cookie.
  Password change/reset invalidates all existing sessions.
* Every query is scoped to the user id from the verified JWT — never from the request body.
* Helmet, CORS allow-list, rate limits (auth: 20/15 min, sends: 10/min), a required
  `X-Requested-With` header on state-changing requests (CSRF), `$`-key stripping and zod validation
  on every input (NoSQL injection), escaped HTML in emails, no stack traces in production.
* Never commit `.env` files. Both `.gitignore` files exclude them.
