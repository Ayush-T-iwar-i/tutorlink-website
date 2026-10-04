const express = require('express');
const router = express.Router();
const { OAuth2Client } = require('google-auth-library');
const { body, validationResult } = require('express-validator');
const db = require('../config/db');
const { sendMail } = require('../config/email');
const emailTemplates = require('../config/email-templates');
const { verifyToken } = require('../middleware/auth.middleware');
const sessions = require('../lib/sessions');
const tokens = require('../lib/session-tokens');
const passwords = require('../lib/passwords');
const throttle = require('../lib/login-throttle');
const { withTransaction } = require('../lib/tx');
const { runAfterResponse } = require('../lib/after-response');

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// The same text for every failed login, whatever the reason (no such account, wrong password,
// Google-only account), so the response never tells an attacker which emails are registered.
const BAD_LOGIN = 'Invalid email or password. If you signed up with Google, use "Continue with Google".';
const SESSION_EXPIRED = { error: 'Your session has expired. Please log in again.', code: 'SESSION_EXPIRED' };

const EMAIL_COOLDOWN_SECONDS = 60;

const str = (value, max) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);
const baseUrl = (req) => process.env.FRONTEND_URL || `${req.protocol}://${req.get('host')}`;

async function startSession(res, user, req) {
  const session = await sessions.issueSession(db, user, req);
  tokens.setAuthCookies(res, session);
  return session;
}

function firstValidationError(req, res) {
  const errors = validationResult(req);
  if (errors.isEmpty()) return false;
  res.status(422).json({ error: errors.array()[0].msg });
  return true;
}

// ---------- SIGNUP ----------
// POST /api/auth/signup
// body (common): { name, email, phone, password, role: "student" | "teacher" }
// body (student, optional): { preferred_grade, preferred_subjects }
// body (teacher, optional): { subjects, qualification, experience_years }
router.post('/signup', [
  body('name').trim().isLength({ min: 2, max: 120 }).withMessage('Please enter your full name (2-120 characters).'),
  body('email').trim().isLength({ max: 150 }).withMessage('That email address is too long.')
    .bail().isEmail().withMessage('Please enter a valid email address.').normalizeEmail(),
  body('phone').trim().matches(/^[6-9]\d{9}$/).withMessage('Please enter a valid 10-digit Indian mobile number.'),
  body('password').custom(passwords.passwordRule('Password')),
  body('role').isIn(['student', 'teacher']).withMessage('Role must be student or teacher.'),
], async (req, res) => {
  if (firstValidationError(req, res)) return;

  try {
    const { name, email, phone, password, role } = req.body;

    const [existingEmail] = await db.query('SELECT id FROM users WHERE email = ?', [email]);
    if (existingEmail.length > 0) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }
    const [existingPhone] = await db.query('SELECT id FROM users WHERE phone = ?', [phone]);
    if (existingPhone.length > 0) {
      return res.status(409).json({ error: 'An account with this phone number already exists. Try logging in instead.' });
    }

    const passwordHash = await passwords.hashPassword(password);
    const verification = tokens.generateEmailToken();

    // The user row and its student/teacher profile row are created together or not at all.
    const userId = await withTransaction(db, async (conn) => {
      const [result] = await conn.query(
        `INSERT INTO users (name, email, phone, password_hash, role, email_verify_token, email_verify_expires)
         VALUES (?, ?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 24 HOUR))`,
        [name, email, phone, passwordHash, role, verification.hash]
      );
      if (role === 'student') {
        await conn.query(
          'INSERT INTO students (user_id, preferred_grade, preferred_subjects) VALUES (?, ?, ?)',
          [result.insertId, str(req.body.preferred_grade, 50), str(req.body.preferred_subjects, 255)]
        );
      } else {
        await conn.query(
          'INSERT INTO teachers (user_id, subjects, qualification, experience_years) VALUES (?, ?, ?, ?)',
          [result.insertId, str(req.body.subjects, 255) || '', str(req.body.qualification, 255),
            Math.min(60, Math.max(0, parseInt(req.body.experience_years, 10) || 0))]
        );
      }
      return result.insertId;
    });

    await startSession(res, { id: userId, role }, req);

    res.status(201).json({
      message: 'Account created successfully.',
      user: { id: userId, name, email, role, email_verified: false },
    });

    runAfterResponse(res, 'Verification email', async () => {
      const link = `${baseUrl(req)}/verify-email.html?token=${verification.raw}`;
      const { subject, html } = emailTemplates.emailVerification(link);
      await sendMail({ to: email, subject, html });
    });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'That email or phone number is already registered. Try logging in instead.' });
    }
    console.error('Signup error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Something went wrong during signup.' });
  }
});

// ---------- LOGIN ----------
// POST /api/auth/login
// body: { email, password }
router.post('/login', [
  body('email').trim().isEmail().withMessage('Please enter a valid email address.').normalizeEmail(),
  body('password').isString().notEmpty().withMessage('Password is required.'),
], async (req, res) => {
  if (firstValidationError(req, res)) return;

  try {
    const { email, password } = req.body;
    const ip = req.ip || 'unknown';

    const minutes = await throttle.minutesLocked(db, email, ip);
    if (minutes > 0) {
      return res.status(423).json({ error: `Too many failed attempts. Please try again in ${minutes} minute(s).`, code: 'LOCKED' });
    }

    const [rows] = await db.query('SELECT id, name, email, role, password_hash FROM users WHERE email = ?', [email]);
    const user = rows[0];

    // Always runs a bcrypt comparison (against a dummy hash when there is no usable account),
    // so unknown emails cost the same time as wrong passwords.
    const ok = await passwords.verifyPassword(password, user && user.password_hash);

    if (!user || !ok) {
      const nowLocked = await throttle.recordFailure(db, email, ip);
      if (nowLocked) {
        return res.status(423).json({ error: `Too many failed attempts. Please try again in ${throttle.LOCK_MINUTES} minute(s).`, code: 'LOCKED' });
      }
      return res.status(401).json({ error: BAD_LOGIN });
    }

    await throttle.clearPair(db, email, ip);
    await startSession(res, user, req);

    res.json({
      message: 'Login successful.',
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Something went wrong during login.' });
  }
});

// ---------- REFRESH THE SESSION ----------
// POST /api/auth/refresh
// Uses the httpOnly refresh cookie (path-restricted to /api/auth). Rotates the refresh token on every
// call. Presenting an old token after the short grace period revokes the whole session.
router.post('/refresh', async (req, res) => {
  try {
    const raw = req.cookies && req.cookies[tokens.REFRESH_COOKIE];
    const result = await sessions.rotateSession(db, raw, req);

    if (result.status === 'ok' || result.status === 'grace') {
      const accessToken = tokens.signAccessToken({ id: result.user.id, role: result.user.role, sid: result.sessionId });
      // On 'grace' another tab already received the newer refresh cookie, so only the access cookie is set.
      tokens.setAuthCookies(res, { accessToken, refreshToken: result.status === 'ok' ? result.refreshToken : null });
      return res.json({ message: 'Session refreshed.', user: { id: result.user.id, role: result.user.role } });
    }

    if (result.status === 'reuse') {
      console.warn(`Refresh token reuse detected; session revoked (user ${result.userId}).`);
    }
    tokens.clearAuthCookies(res);
    res.status(401).json(SESSION_EXPIRED);
  } catch (err) {
    console.error('Refresh error:', err);
    res.status(500).json({ error: 'Could not refresh your session.' });
  }
});

// ---------- FORGOT PASSWORD ----------
// POST /api/auth/forgot-password
// body: { email }
// Answers immediately and identically whether or not the account exists; the work (and the email)
// happens after the response so timing reveals nothing either.
router.post('/forgot-password', [
  body('email').trim().isEmail().withMessage('Please enter a valid email address.').normalizeEmail(),
], async (req, res) => {
  if (firstValidationError(req, res)) return;

  const { email } = req.body;
  res.json({ message: "If an account exists for that email, we've sent a reset link." });

  runAfterResponse(res, 'Password reset email', async () => {
    const [rows] = await db.query(
      `SELECT id, (reset_token_expires IS NOT NULL
                   AND TIMESTAMPDIFF(SECOND, DATE_SUB(reset_token_expires, INTERVAL 1 HOUR), NOW()) < ?) AS too_soon
       FROM users WHERE email = ?`,
      [EMAIL_COOLDOWN_SECONDS, email]
    );
    if (rows.length === 0 || rows[0].too_soon) return; // unknown account, or a link was sent a moment ago

    const reset = tokens.generateEmailToken();
    await db.query(
      'UPDATE users SET reset_token = ?, reset_token_expires = DATE_ADD(NOW(), INTERVAL 1 HOUR) WHERE id = ?',
      [reset.hash, rows[0].id]
    );
    const link = `${baseUrl(req)}/reset-password.html?token=${reset.raw}`;
    const { subject, html } = emailTemplates.passwordReset(link);
    await sendMail({ to: email, subject, html });
  });
});

// ---------- RESET PASSWORD ----------
// POST /api/auth/reset-password
// body: { token, password }
// The token is single-use (claimed atomically), expires after 1 hour and is stored only as a hash.
// A successful reset signs the account out everywhere and clears any login lockout.
router.post('/reset-password', [
  body('token').isString().isLength({ min: 1, max: 200 }).withMessage('Reset token is required.'),
  body('password').custom(passwords.passwordRule('Password')),
], async (req, res) => {
  if (firstValidationError(req, res)) return;

  try {
    const { token, password } = req.body;
    const tokenHash = tokens.hashToken(token);
    const invalid = { error: 'This reset link is invalid or has expired. Please request a new one.' };

    const [rows] = await db.query(
      'SELECT id, email FROM users WHERE reset_token = ? AND reset_token_expires > NOW()',
      [tokenHash]
    );
    if (rows.length === 0) return res.status(400).json(invalid);
    const user = rows[0];

    const passwordHash = await passwords.hashPassword(password);
    // Conditional update = atomic claim: of two simultaneous uses of one link, only one changes a row.
    // A reset proves control of the mailbox, so the email counts as verified too.
    const [claim] = await db.query(
      `UPDATE users SET password_hash = ?, reset_token = NULL, reset_token_expires = NULL, email_verified = 1
       WHERE id = ? AND reset_token = ? AND reset_token_expires > NOW()`,
      [passwordHash, user.id, tokenHash]
    );
    if (claim.affectedRows === 0) return res.status(400).json(invalid);

    await sessions.revokeAllUserSessions(db, user.id, 'password_reset');
    await throttle.clearAll(db, user.email);

    res.json({ message: 'Password updated. You can now log in with your new password.' });

    runAfterResponse(res, 'Password-changed email', async () => {
      const { subject, html } = emailTemplates.passwordChanged();
      await sendMail({ to: user.email, subject, html });
    });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ---------- CHANGE PASSWORD (logged in, protected) ----------
// PUT /api/auth/change-password
// body: { current_password, new_password }
// Signs every other device out; this device gets a fresh session so the user stays logged in.
router.put('/change-password', verifyToken, [
  body('current_password').isString().notEmpty().withMessage('Please enter your current password.'),
  body('new_password').custom(passwords.passwordRule('New password')),
], async (req, res) => {
  if (firstValidationError(req, res)) return;

  try {
    const { current_password, new_password } = req.body;

    const [rows] = await db.query('SELECT id, email, role, password_hash FROM users WHERE id = ?', [req.user.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Account not found.' });
    const user = rows[0];

    if (!user.password_hash) {
      return res.status(400).json({ error: 'This account signed up with Google and has no password set yet. Use "Forgot password" to set one.' });
    }
    if (!(await passwords.verifyPassword(current_password, user.password_hash))) {
      return res.status(401).json({ error: 'Your current password is incorrect.' });
    }
    if (await passwords.verifyPassword(new_password, user.password_hash)) {
      return res.status(422).json({ error: 'Your new password must be different from your current one.' });
    }

    await db.query('UPDATE users SET password_hash = ? WHERE id = ?', [await passwords.hashPassword(new_password), user.id]);
    await sessions.revokeAllUserSessions(db, user.id, 'password_change');
    await startSession(res, user, req);

    res.json({ message: 'Password updated successfully.' });

    runAfterResponse(res, 'Password-changed email', async () => {
      const { subject, html } = emailTemplates.passwordChanged();
      await sendMail({ to: user.email, subject, html });
    });
  } catch (err) {
    console.error('Change password error:', err);
    res.status(500).json({ error: 'Could not change password.' });
  }
});

// ---------- GET CURRENT LOGGED-IN USER ----------
// GET /api/auth/me
router.get('/me', verifyToken, async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT id, name, email, phone, role, profile_photo, email_verified FROM users WHERE id = ?',
      [req.user.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }
    res.json({ user: rows[0] });
  } catch (err) {
    console.error('Get current user error:', err);
    res.status(500).json({ error: 'Could not fetch user.' });
  }
});

// ---------- GOOGLE SIGN-IN / SIGN-UP ----------
// POST /api/auth/google
// body: { credential, role }
router.post('/google', async (req, res) => {
  try {
    const { credential, role } = req.body || {};

    if (typeof credential !== 'string' || !credential) {
      return res.status(400).json({ error: 'Missing Google credential.' });
    }
    if (!process.env.GOOGLE_CLIENT_ID) {
      return res.status(500).json({ error: 'Google sign-in is not configured on this server yet.' });
    }

    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const { sub: googleId, email: rawEmail, name, email_verified: googleVerified } = ticket.getPayload();
    const email = typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase() : '';

    // Never trust an email address Google itself has not verified: linking by email would otherwise let
    // someone take over an existing TutorLink account.
    if (!googleId || !email || googleVerified !== true) {
      return res.status(401).json({ error: 'Your Google account does not have a verified email address.' });
    }

    const [existing] = await db.query(
      'SELECT id, name, email, role, google_id FROM users WHERE google_id = ? OR email = ? ORDER BY (google_id = ?) DESC LIMIT 1',
      [googleId, email, googleId]
    );

    let user;
    if (existing.length > 0) {
      user = existing[0];
      if (user.google_id && user.google_id !== googleId) {
        // This email belongs to an account already linked to a different Google identity.
        return res.status(409).json({ error: 'This email is already linked to a different Google account.' });
      }
      await db.query('UPDATE users SET google_id = ?, email_verified = 1 WHERE id = ?', [googleId, user.id]);
    } else {
      if (!role || !['student', 'teacher'].includes(role)) {
        return res.status(400).json({ error: 'Please choose whether you are a student or a teacher first.' });
      }
      const userId = await withTransaction(db, async (conn) => {
        const [result] = await conn.query(
          'INSERT INTO users (name, email, google_id, role, email_verified) VALUES (?, ?, ?, ?, 1)',
          [str(name, 120) || email.split('@')[0], email, googleId, role]
        );
        if (role === 'student') await conn.query('INSERT INTO students (user_id) VALUES (?)', [result.insertId]);
        else await conn.query('INSERT INTO teachers (user_id, subjects) VALUES (?, ?)', [result.insertId, '']);
        return result.insertId;
      });
      user = { id: userId, name: str(name, 120) || email.split('@')[0], email, role };
    }

    await startSession(res, user, req);

    res.json({
      message: 'Signed in with Google.',
      user: { id: user.id, name: user.name, email: user.email, role: user.role, email_verified: true },
    });
  } catch (err) {
    console.error('Google sign-in error:', err);
    res.status(401).json({ error: 'Could not verify Google sign-in. Please try again.' });
  }
});

// ---------- VERIFY EMAIL ----------
// GET /api/auth/verify-email?token=...
// Public route — the link from the verification email hits this directly. Single-use and hashed at rest.
router.get('/verify-email', async (req, res) => {
  try {
    const token = req.query.token;
    if (typeof token !== 'string' || !token || token.length > 200) {
      return res.status(400).json({ error: 'Verification token is required.' });
    }

    const [claim] = await db.query(
      `UPDATE users SET email_verified = 1, email_verify_token = NULL, email_verify_expires = NULL
       WHERE email_verify_token = ? AND email_verify_expires > NOW()`,
      [tokens.hashToken(token)]
    );
    if (claim.affectedRows === 0) {
      return res.status(400).json({ error: 'This verification link is invalid or has expired. Please request a new one.' });
    }
    res.json({ message: 'Email verified successfully.' });
  } catch (err) {
    console.error('Verify email error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ---------- RESEND VERIFICATION EMAIL (logged in, protected) ----------
// POST /api/auth/resend-verification
router.post('/resend-verification', verifyToken, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT email, email_verified,
              CASE WHEN email_verify_expires IS NULL THEN NULL
                   ELSE TIMESTAMPDIFF(SECOND, DATE_SUB(email_verify_expires, INTERVAL 24 HOUR), NOW()) END AS seconds_since_sent
       FROM users WHERE id = ?`,
      [req.user.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Account not found.' });
    const user = rows[0];
    if (user.email_verified) return res.status(400).json({ error: 'Your email is already verified.' });

    if (user.seconds_since_sent !== null && user.seconds_since_sent < EMAIL_COOLDOWN_SECONDS) {
      return res.status(429).json({ error: 'A verification email was just sent. Please wait a minute before asking for another.', code: 'RESEND_COOLDOWN' });
    }

    const verification = tokens.generateEmailToken();
    await db.query(
      'UPDATE users SET email_verify_token = ?, email_verify_expires = DATE_ADD(NOW(), INTERVAL 24 HOUR) WHERE id = ?',
      [verification.hash, req.user.id]
    );
    res.json({ message: 'Verification email sent. Please check your inbox.' });

    runAfterResponse(res, 'Verification email', async () => {
      const link = `${baseUrl(req)}/verify-email.html?token=${verification.raw}`;
      const { subject, html } = emailTemplates.emailVerification(link);
      await sendMail({ to: user.email, subject, html });
    });
  } catch (err) {
    console.error('Resend verification error:', err);
    res.status(500).json({ error: 'Could not resend verification email.' });
  }
});

// ---------- LOGOUT ----------
// POST /api/auth/logout
// Revokes the server-side session (so a copied token stops working immediately) and clears both cookies.
// Always succeeds from the caller's point of view.
router.post('/logout', async (req, res) => {
  try {
    let sessionId = null;
    const access = req.cookies && req.cookies[tokens.ACCESS_COOKIE];
    if (access) {
      try { sessionId = tokens.verifyAccessToken(access, { ignoreExpiration: true }).sid; } catch (_) { /* unreadable token */ }
    }
    if (!Number.isInteger(sessionId)) {
      sessionId = await sessions.findSessionIdByRefreshToken(db, req.cookies && req.cookies[tokens.REFRESH_COOKIE]);
    }
    if (Number.isInteger(sessionId)) await sessions.revokeSession(db, sessionId, 'logout');
  } catch (err) {
    console.error('Logout error:', err);
  }
  tokens.clearAuthCookies(res);
  res.json({ message: 'Logged out.' });
});

// ---------- LOGOUT EVERYWHERE ----------
// POST /api/auth/logout-all
router.post('/logout-all', verifyToken, async (req, res) => {
  try {
    await sessions.revokeAllUserSessions(db, req.user.id, 'logout_all');
    tokens.clearAuthCookies(res);
    res.json({ message: 'Logged out of all devices.' });
  } catch (err) {
    console.error('Logout-all error:', err);
    res.status(500).json({ error: 'Could not log out of all devices.' });
  }
});

module.exports = router;