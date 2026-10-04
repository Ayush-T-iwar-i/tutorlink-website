const cron = require('node-cron');
const db = require('../config/db');
const sessions = require('../lib/sessions');

// Removes expired/revoked sessions, stale login-failure counters and old webhook event ids.
async function runCleanup() {
  try {
    const removed = await sessions.cleanupExpired(db);
    console.log(`[cleanup] removed ${removed.sessions} session(s), ${removed.loginFailures} login counter(s), ${removed.paymentEvents} webhook record(s)`);
    return removed;
  } catch (err) {
    console.error('Cleanup job failed:', err);
    return null;
  }
}

// Daily at 03:15 server time. Never throws.
function startCleanupJob() {
  cron.schedule('15 3 * * *', runCleanup);
  console.log('✅ Cleanup job scheduled (daily 03:15)');
}

module.exports = { startCleanupJob, runCleanup };