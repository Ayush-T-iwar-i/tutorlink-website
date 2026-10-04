/**
 * Database side of authentication: creating, validating, rotating and revoking sessions.
 * All time arithmetic happens in SQL (NOW(), DATE_ADD) so it never depends on the Node server's timezone.
 */
const t = require('./session-tokens');
const { withTransaction } = require('./tx');

const clip = (v, n) => (v == null ? null : String(v).slice(0, n));

/** Create a session for a freshly authenticated user. Returns { accessToken, refreshToken, sessionId }. */
async function issueSession(db, user, req = {}) {
  const refreshToken = t.generateRefreshToken();
  const [r] = await db.query(
    `INSERT INTO sessions (user_id, refresh_hash, expires_at, user_agent, ip, last_used_at)
     VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? DAY), ?, ?, NOW())`,
    [user.id, t.hashToken(refreshToken), t.refreshTtlDays(), clip(req.get && req.get('user-agent'), 255), clip(req.ip, 45)]
  );
  const accessToken = t.signAccessToken({ id: user.id, role: user.role, sid: r.insertId });
  return { accessToken, refreshToken, sessionId: r.insertId };
}

/**
 * Is the session inside this (already signature-checked) access token still alive?
 * Returns the CURRENT user row (role comes from the database, never from the token) or null.
 */
async function authenticateAccessToken(db, decoded) {
  if (!decoded || !Number.isInteger(decoded.sid) || !Number.isInteger(decoded.id)) return null;
  const [rows] = await db.query(
    `SELECT u.id, u.role, u.email_verified
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = ? AND s.user_id = ? AND s.revoked_at IS NULL AND s.expires_at > NOW()`,
    [decoded.sid, decoded.id]
  );
  return rows[0] || null;
}

/**
 * Exchange a refresh token for a new one.
 *   ok       token valid -> rotated; caller sets BOTH cookies
 *   grace    token was rotated moments ago (another tab) -> caller sets only a fresh access cookie
 *   reuse    an old token came back after the grace period -> session revoked (probable theft)
 *   invalid  unknown / expired / revoked
 */
async function rotateSession(db, rawRefresh, req = {}) {
  if (typeof rawRefresh !== 'string' || rawRefresh.length < 20 || rawRefresh.length > 100) return { status: 'invalid' };
  const hash = t.hashToken(rawRefresh);

  return withTransaction(db, async (conn) => {
    const select = (column) => conn.query(
      `SELECT s.id, s.user_id, s.created_at, s.revoked_at,
              (s.expires_at > NOW() AND DATE_ADD(s.created_at, INTERVAL ${t.REFRESH_ABSOLUTE_DAYS} DAY) > NOW()) AS live,
              TIMESTAMPDIFF(SECOND, s.rotated_at, NOW()) AS seconds_since_rotation,
              u.role, u.email_verified
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.${column} = ? FOR UPDATE OF s`,
      [hash]
    );

    let [rows] = await select('refresh_hash');
    if (rows.length > 0) {
      const s = rows[0];
      if (s.revoked_at || !s.live) return { status: 'invalid' };
      const refreshToken = t.generateRefreshToken();
      await conn.query(
        `UPDATE sessions SET prev_refresh_hash = refresh_hash, refresh_hash = ?, rotated_at = NOW(), last_used_at = NOW(),
           ip = ?, expires_at = LEAST(DATE_ADD(created_at, INTERVAL ? DAY), DATE_ADD(NOW(), INTERVAL ? DAY))
         WHERE id = ?`,
        [t.hashToken(refreshToken), clip(req.ip, 45), t.REFRESH_ABSOLUTE_DAYS, t.refreshTtlDays(), s.id]
      );
      return { status: 'ok', user: { id: s.user_id, role: s.role }, sessionId: s.id, refreshToken };
    }

    [rows] = await select('prev_refresh_hash');
    if (rows.length === 0) return { status: 'invalid' };
    const s = rows[0];
    if (s.revoked_at || !s.live) return { status: 'invalid' };
    if (s.seconds_since_rotation !== null && s.seconds_since_rotation <= t.REFRESH_GRACE_SECONDS) {
      return { status: 'grace', user: { id: s.user_id, role: s.role }, sessionId: s.id };
    }
    await conn.query("UPDATE sessions SET revoked_at = NOW(), revoked_reason = 'reuse_detected' WHERE id = ? AND revoked_at IS NULL", [s.id]);
    return { status: 'reuse', userId: s.user_id };
  });
}

async function revokeSession(db, sessionId, reason) {
  if (!Number.isInteger(sessionId)) return 0;
  const [r] = await db.query('UPDATE sessions SET revoked_at = NOW(), revoked_reason = ? WHERE id = ? AND revoked_at IS NULL', [reason, sessionId]);
  return r.affectedRows;
}

/** Revoke every live session of a user (optionally keeping one). */
async function revokeAllUserSessions(db, userId, reason, exceptSessionId = null) {
  const [r] = await db.query(
    'UPDATE sessions SET revoked_at = NOW(), revoked_reason = ? WHERE user_id = ? AND revoked_at IS NULL AND (? IS NULL OR id <> ?)',
    [reason, userId, exceptSessionId, exceptSessionId]
  );
  return r.affectedRows;
}

/** Find the session a refresh cookie belongs to (used by logout). */
async function findSessionIdByRefreshToken(db, rawRefresh) {
  if (typeof rawRefresh !== 'string' || !rawRefresh) return null;
  const [rows] = await db.query('SELECT id FROM sessions WHERE refresh_hash = ?', [t.hashToken(rawRefresh)]);
  return rows.length ? rows[0].id : null;
}

/** Housekeeping, run daily by jobs/cleanup.js. */
async function cleanupExpired(db) {
  const [s] = await db.query(
    `DELETE FROM sessions WHERE expires_at < DATE_SUB(NOW(), INTERVAL 7 DAY) OR revoked_at < DATE_SUB(NOW(), INTERVAL 30 DAY)`
  );
  const [l] = await db.query(
    `DELETE FROM login_failures WHERE window_started_at < DATE_SUB(NOW(), INTERVAL 1 DAY) AND (locked_until IS NULL OR locked_until < NOW())`
  );
  const [e] = await db.query('DELETE FROM payment_events WHERE received_at < DATE_SUB(NOW(), INTERVAL 90 DAY)');
  return { sessions: s.affectedRows, loginFailures: l.affectedRows, paymentEvents: e.affectedRows };
}

module.exports = {
  issueSession, authenticateAccessToken, rotateSession,
  revokeSession, revokeAllUserSessions, findSessionIdByRefreshToken, cleanupExpired,
};