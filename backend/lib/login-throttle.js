/**
 * Brute-force protection for login.
 *
 *  - Per (email, IP): 5 failures lock that pair for 15 minutes. An attacker therefore cannot lock the
 *    real owner out of their own account from a different IP.
 *  - Per email overall: 25 failures across all IPs in 15 minutes throttle the account (distributed guessing).
 *  - Unknown emails are tracked exactly like real ones, so "locked" never reveals that an account exists.
 *    The email is stored only as a hash.
 */
const crypto = require('crypto');

const MAX_PAIR_FAILURES = 5;
const MAX_ACCOUNT_FAILURES = 25;
const WINDOW_MINUTES = 15;
const LOCK_MINUTES = 15;

const emailHash = (email) => crypto.createHash('sha256').update(String(email).trim().toLowerCase()).digest('hex');

/** Returns minutes to wait (>0) if this attempt must be refused, else 0. */
async function minutesLocked(db, email, ip) {
  const h = emailHash(email);
  const [pair] = await db.query(
    'SELECT CEIL(TIMESTAMPDIFF(SECOND, NOW(), locked_until) / 60) AS mins FROM login_failures WHERE email_hash = ? AND ip = ? AND locked_until > NOW()',
    [h, ip]
  );
  if (pair.length > 0) return Math.max(1, Number(pair[0].mins));

  const [total] = await db.query(
    'SELECT COALESCE(SUM(failures), 0) AS n FROM login_failures WHERE email_hash = ? AND window_started_at > DATE_SUB(NOW(), INTERVAL ? MINUTE)',
    [h, WINDOW_MINUTES]
  );
  return Number(total[0].n) >= MAX_ACCOUNT_FAILURES ? WINDOW_MINUTES : 0;
}

/** Record a failed attempt. Returns true when this failure just locked the pair. */
async function recordFailure(db, email, ip) {
  const h = emailHash(email);
  // MySQL evaluates the assignments left to right, so the third one already sees the new `failures` value.
  await db.query(
    `INSERT INTO login_failures (email_hash, ip, failures, window_started_at) VALUES (?, ?, 1, NOW())
     ON DUPLICATE KEY UPDATE
       failures = IF(window_started_at < DATE_SUB(NOW(), INTERVAL ? MINUTE), 1, failures + 1),
       window_started_at = IF(window_started_at < DATE_SUB(NOW(), INTERVAL ? MINUTE), NOW(), window_started_at),
       locked_until = IF(failures >= ?, DATE_ADD(NOW(), INTERVAL ? MINUTE), locked_until)`,
    [h, ip, WINDOW_MINUTES, WINDOW_MINUTES, MAX_PAIR_FAILURES, LOCK_MINUTES]
  );
  const [rows] = await db.query('SELECT (locked_until > NOW()) AS locked FROM login_failures WHERE email_hash = ? AND ip = ?', [h, ip]);
  return rows.length > 0 && Boolean(rows[0].locked);
}

/** After a successful login, forget this pair's failures. */
async function clearPair(db, email, ip) {
  await db.query('DELETE FROM login_failures WHERE email_hash = ? AND ip = ?', [emailHash(email), ip]);
}

/** After a password reset, forget every failure for the account. */
async function clearAll(db, email) {
  await db.query('DELETE FROM login_failures WHERE email_hash = ?', [emailHash(email)]);
}

module.exports = { MAX_PAIR_FAILURES, MAX_ACCOUNT_FAILURES, LOCK_MINUTES, emailHash, minutesLocked, recordFailure, clearPair, clearAll };