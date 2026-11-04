import { API_PREFIX } from "./config/apiPath.js";
import { connectDB, disconnectDB } from "./config/db.js";
import { env } from "./config/env.js";
import { createApp } from "./app.js";
import { backfillContactIntel } from "./services/contactIntel.js";
import { isDryRun, verifyTransport } from "./services/emailService.js";
import { startScheduler, stopScheduler } from "./services/schedulerService.js";
import { INSTANCE_ID } from "./utils/instance.js";

function listen(app, port) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port);
    server.once("listening", () => resolve(server));
    server.once("error", reject);
  });
}

/**
 * On Windows a second process can bind the same port (IPv4 vs IPv6) without an error, and then
 * silently serve nothing while its scheduler still sends mail. Ask both loopback addresses who
 * answers; if it isn't this process, another MailFlow backend owns the port.
 */
async function assertOwnsPort(port) {
  for (const host of ["127.0.0.1", "[::1]"]) {
    let body;
    try {
      const res = await fetch(`http://${host}:${port}${API_PREFIX}/health`, { signal: AbortSignal.timeout(3000) });
      body = await res.json();
    } catch {
      continue; // address family not available
    }
    if (body?.instance !== INSTANCE_ID) {
      throw new Error(
        `Port ${port} is already served by another process (${host} answered for it). ` +
          "Another MailFlow backend is probably running — stop it, or set a different PORT.",
      );
    }
  }
}

async function main() {
  await connectDB();

  let server;
  try {
    server = await listen(createApp(), env.PORT);
    await assertOwnsPort(env.PORT);
  } catch (err) {
    const message =
      err?.code === "EADDRINUSE" ? `Port ${env.PORT} is already in use. Stop the other backend or set a different PORT.` : err.message;
    console.error(`❌ ${message}`);
    await disconnectDB();
    process.exit(1);
  }
  console.log(`🚀 MailFlow API listening on port ${env.PORT} (${env.NODE_ENV})`);

  if (isDryRun()) {
    console.warn("⚠️  EMAIL_TRANSPORT=json — DRY RUN: emails are built and recorded but NOT delivered to anyone.");
  } else {
    verifyTransport()
      .then(() => console.log(`✅ Gmail SMTP ready (${env.GMAIL_USER})`))
      .catch((err) => console.error(`⚠️  Gmail SMTP check failed: ${err.message}. Sending will fail until fixed.`));
  }

  // Contacts created before email statistics existed get them from EmailHistory once.
  backfillContactIntel().catch((err) => console.error("Contact statistics update failed:", err?.message));

  // Only a server that really owns its port runs the scheduler.
  if (env.SCHEDULER_ENABLED) startScheduler();

  const shutdown = async (signal) => {
    console.log(`${signal} received, shutting down`);
    stopScheduler();
    server.close(async () => {
      await disconnectDB();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("❌ Failed to start:", err.message);
  process.exit(1);
});
