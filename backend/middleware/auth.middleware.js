const db = require('../config/db');
const sessions = require('../lib/sessions');
const { verifyAccessToken, ACCESS_COOKIE } = require('../lib/session-tokens');

// ---------- Verify that a valid, still-active login was sent ----------
// The access token arrives as the httpOnly "token" cookie (Authorization: Bearer is accepted for
// non-browser clients). Checking the signature is not enough: the session behind the token must
// still be alive in the database, so logout, password change and account deletion take effect
// immediately — and the user's role is read from the database, never trusted from the token.
//
// 401 codes the frontend can act on:
//   NO_TOKEN / INVALID_TOKEN / SESSION_REVOKED -> log in again
//   TOKEN_EXPIRED                               -> call POST /api/auth/refresh once, then retry
async function verifyToken(req, res, next) {
  let token = req.cookies && req.cookies[ACCESS_COOKIE];

  if (!token) {
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.split(' ')[1];
    }
  }

  if (!token) {
    return res.status(401).json({ error: 'Not logged in. Please log in and try again.', code: 'NO_TOKEN' });
  }

  let decoded;
  try {
    decoded = verifyAccessToken(token);
  } catch (err) {
    return res.status(401).json({
      error: 'Your session has expired. Please log in again.',
      code: err && err.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN',
    });
  }

  try {
    const user = await sessions.authenticateAccessToken(db, decoded);
    if (!user) {
      return res.status(401).json({ error: 'Your session has expired. Please log in again.', code: 'SESSION_REVOKED' });
    }
    req.user = { id: user.id, role: user.role, sid: decoded.sid, email_verified: Boolean(user.email_verified) };
    next();
  } catch (err) {
    console.error('Session lookup failed:', err);
    res.status(503).json({ error: 'We could not check your login right now. Please try again.', code: 'AUTH_UNAVAILABLE' });
  }
}

// ---------- Verify the logged-in user has a specific role ----------
// Usage: verifyToken, requireRole('teacher')
function requireRole(role) {
  return (req, res, next) => {
    if (!req.user || req.user.role !== role) {
      return res.status(403).json({ error: `Only ${role}s can perform this action.` });
    }
    next();
  };
}

// ---------- Require a verified email for actions that commit money or someone else's time ----------
// Usage: verifyToken, requireVerifiedEmail
function requireVerifiedEmail(req, res, next) {
  if (!req.user || !req.user.email_verified) {
    return res.status(403).json({
      error: 'Please verify your email address first. Check your inbox, or request a new link from your dashboard.',
      code: 'EMAIL_NOT_VERIFIED',
    });
  }
  next();
}

// ---------- Verify the logged-in user is acting on their own account ----------
// Usage: verifyToken, requireOwnUser  — for routes like /:userId/profile
function requireOwnUser(req, res, next) {
  const targetUserId = parseInt(req.params.userId, 10);
  if (req.user.id !== targetUserId) {
    return res.status(403).json({ error: 'You can only update your own account.' });
  }
  next();
}

module.exports = { verifyToken, requireRole, requireVerifiedEmail, requireOwnUser };