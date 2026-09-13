const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const { body, validationResult } = require('express-validator');
const db = require('../config/db');
const { sendMail } = require('../config/email');
const emailTemplates = require('../config/email-templates');
const { verifyToken } = require('../middleware/auth.middleware');

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// The JWT lives in an httpOnly cookie so client-side JS can never read it —
// closes off token theft via XSS. `secure` only in production because local
// HTTP dev servers can't set secure cookies. `sameSite: 'lax'` allows the
// cookie on normal top-level navigation (e.g. clicking a link to the site)
// while still blocking it on cross-site POSTs.
function setAuthCookie(res, token) {
  res.cookie('token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days, matches the JWT's own expiry
  });
}

// ---------- SIGNUP ----------
// POST /api/auth/signup
// body (common): { name, email, phone, password, role: "student" | "teacher" }
// body (student, optional): { preferred_grade, preferred_subjects }
// body (teacher, optional): { subjects, qualification, experience_years }
router.post('/signup', [
  body('name').trim().isLength({ min: 2 }).withMessage('Please enter your full name.'),
  body('email').trim().isEmail().withMessage('Please enter a valid email address.').normalizeEmail(),
  body('phone').trim().matches(/^[6-9]\d{9}$/).withMessage('Please enter a valid 10-digit Indian mobile number.'),
  body('password')
    .isLength({ min: 8 }).withMessage('Password must be at least 8 characters.')
    .matches(/[A-Z]/).withMessage('Password must include at least one uppercase letter.')
    .matches(/[a-z]/).withMessage('Password must include at least one lowercase letter.')
    .matches(/[0-9]/).withMessage('Password must include at least one number.'),
  body('role').isIn(['student', 'teacher']).withMessage('Role must be student or teacher.'),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ error: errors.array()[0].msg });
  }

  try {
    const {
      name, email, phone, password, role,
      preferred_grade, preferred_subjects,
      subjects, qualification, experience_years,
    } = req.body;

    if (!name || !email || !phone || !password || !role) {
      return res.status(400).json({ error: 'All fields are required.' });
    }
    if (!['student', 'teacher'].includes(role)) {
      return res.status(400).json({ error: 'Role must be student or teacher.' });
    }

    const [existingEmail] = await db.query('SELECT id FROM users WHERE email = ?', [email]);
    if (existingEmail.length > 0) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }
    const [existingPhone] = await db.query('SELECT id FROM users WHERE phone = ?', [phone]);
    if (existingPhone.length > 0) {
      return res.status(409).json({ error: 'An account with this phone number already exists. Try logging in instead.' });
    }

    const password_hash = await bcrypt.hash(password, 10);

    const [result] = await db.query(
      'INSERT INTO users (name, email, phone, password_hash, role) VALUES (?, ?, ?, ?, ?)',
      [name, email, phone, password_hash, role]
    );

    const userId = result.insertId;

    if (role === 'student') {
      await db.query(
        'INSERT INTO students (user_id, preferred_grade, preferred_subjects) VALUES (?, ?, ?)',
        [userId, preferred_grade || null, preferred_subjects || null]
      );
    } else if (role === 'teacher') {
      await db.query(
        'INSERT INTO teachers (user_id, subjects, qualification, experience_years) VALUES (?, ?, ?, ?)',
        [userId, subjects || '', qualification || null, Math.max(0, parseInt(experience_years, 10) || 0)]
      );
    }

    const token = jwt.sign({ id: userId, role }, process.env.JWT_SECRET, { expiresIn: '7d' });
    setAuthCookie(res, token);

    // Send a verification email — doesn't block login, just marks the
    // account unverified until the link is clicked.
    try {
      const emailVerifyToken = crypto.randomBytes(32).toString('hex');
      const verifyExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
      await db.query(
        'UPDATE users SET email_verify_token = ?, email_verify_expires = ? WHERE id = ?',
        [emailVerifyToken, verifyExpires, userId]
      );
      const baseUrl = process.env.FRONTEND_URL || `${req.protocol}://${req.get('host')}`;
      const verifyLink = `${baseUrl}/verify-email.html?token=${emailVerifyToken}`;
      const { subject: verifySubject, html: verifyHtml } = emailTemplates.emailVerification(verifyLink);
      await sendMail({ to: email, subject: verifySubject, html: verifyHtml });
    } catch (verifyErr) {
      console.error('Could not send verification email:', verifyErr);
      // Non-fatal — the account still gets created either way.
    }

    res.status(201).json({
      message: 'Account created successfully.',
      user: { id: userId, name, email, role, email_verified: false }
    });
  } catch (err) {
    console.error('Signup error:', err);
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'That email or phone number is already registered. Try logging in instead.' });
    }
    res.status(500).json({ error: 'Something went wrong during signup.' });
  }
});

// ---------- LOGIN ----------
// POST /api/auth/login
// body: { email, password }
router.post('/login', [
  body('email').trim().isEmail().withMessage('Please enter a valid email address.').normalizeEmail(),
  body('password').notEmpty().withMessage('Password is required.'),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ error: errors.array()[0].msg });
  }

  try {
    const { email, password } = req.body;

    const [rows] = await db.query('SELECT * FROM users WHERE email = ?', [email]);
    if (rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const user = rows[0];

    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      const minutesLeft = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);
      return res.status(423).json({ error: `Too many failed attempts. Please try again in ${minutesLeft} minute(s).` });
    }

    if (!user.password_hash) {
      return res.status(400).json({ error: 'This account signed up with Google. Please use the "Continue with Google" button, or set a password via "Forgot password".' });
    }

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      const attempts = (user.failed_login_attempts || 0) + 1;
      const MAX_ATTEMPTS = 5;
      const LOCK_MINUTES = 15;

      if (attempts >= MAX_ATTEMPTS) {
        const lockedUntil = new Date(Date.now() + LOCK_MINUTES * 60 * 1000);
        await db.query('UPDATE users SET failed_login_attempts = ?, locked_until = ? WHERE id = ?', [attempts, lockedUntil, user.id]);
        return res.status(423).json({ error: `Too many failed attempts. Your account is locked for ${LOCK_MINUTES} minutes.` });
      }

      await db.query('UPDATE users SET failed_login_attempts = ? WHERE id = ?', [attempts, user.id]);
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    if (user.failed_login_attempts > 0 || user.locked_until) {
      await db.query('UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = ?', [user.id]);
    }

    const token = jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '7d' });
    setAuthCookie(res, token);

    res.json({
      message: 'Login successful.',
      user: { id: user.id, name: user.name, email: user.email, role: user.role }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Something went wrong during login.' });
  }
});

// ---------- FORGOT PASSWORD ----------
// POST /api/auth/forgot-password
// body: { email }
router.post('/forgot-password', [
  body('email').trim().isEmail().withMessage('Please enter a valid email address.').normalizeEmail(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ error: errors.array()[0].msg });
  }

  try {
    const { email } = req.body;

    const [rows] = await db.query('SELECT id FROM users WHERE email = ?', [email]);

    if (rows.length > 0) {
      const resetToken = crypto.randomBytes(32).toString('hex');
      const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

      await db.query(
        'UPDATE users SET reset_token = ?, reset_token_expires = ? WHERE id = ?',
        [resetToken, expires, rows[0].id]
      );

      const baseUrl = process.env.FRONTEND_URL || `${req.protocol}://${req.get('host')}`;
      const resetLink = `${baseUrl}/reset-password.html?token=${resetToken}`;

      const { subject, html } = emailTemplates.passwordReset(resetLink);
      await sendMail({ to: email, subject, html });
    }

    res.json({ message: "If an account exists for that email, we've sent a reset link." });
  } catch (err) {
    console.error('Forgot password error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ---------- RESET PASSWORD ----------
// POST /api/auth/reset-password
// body: { token, password }
router.post('/reset-password', [
  body('token').notEmpty().withMessage('Reset token is required.'),
  body('password')
    .isLength({ min: 8 }).withMessage('Password must be at least 8 characters.')
    .matches(/[A-Z]/).withMessage('Password must include at least one uppercase letter.')
    .matches(/[a-z]/).withMessage('Password must include at least one lowercase letter.')
    .matches(/[0-9]/).withMessage('Password must include at least one number.'),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ error: errors.array()[0].msg });
  }

  try {
    const { token, password } = req.body;

    const [rows] = await db.query(
      'SELECT id FROM users WHERE reset_token = ? AND reset_token_expires > NOW()',
      [token]
    );

    if (rows.length === 0) {
      return res.status(400).json({ error: 'This reset link is invalid or has expired. Please request a new one.' });
    }

    const password_hash = await bcrypt.hash(password, 10);
    await db.query(
      'UPDATE users SET password_hash = ?, reset_token = NULL, reset_token_expires = NULL WHERE id = ?',
      [password_hash, rows[0].id]
    );

    res.json({ message: 'Password updated. You can now log in with your new password.' });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ---------- CHANGE PASSWORD (logged in, protected) ----------
// PUT /api/auth/change-password
// body: { current_password, new_password }
router.put('/change-password', verifyToken, [
  body('current_password').notEmpty().withMessage('Please enter your current password.'),
  body('new_password')
    .isLength({ min: 8 }).withMessage('New password must be at least 8 characters.')
    .matches(/[A-Z]/).withMessage('New password must include at least one uppercase letter.')
    .matches(/[a-z]/).withMessage('New password must include at least one lowercase letter.')
    .matches(/[0-9]/).withMessage('New password must include at least one number.'),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ error: errors.array()[0].msg });
  }

  try {
    const { current_password, new_password } = req.body;

    const [rows] = await db.query('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Account not found.' });

    if (!rows[0].password_hash) {
      return res.status(400).json({ error: 'This account signed up with Google and has no password set yet. Use "Forgot password" to set one.' });
    }

    const matches = await bcrypt.compare(current_password, rows[0].password_hash);
    if (!matches) {
      return res.status(401).json({ error: 'Your current password is incorrect.' });
    }

    const newHash = await bcrypt.hash(new_password, 10);
    await db.query('UPDATE users SET password_hash = ? WHERE id = ?', [newHash, req.user.id]);

    res.json({ message: 'Password updated successfully.' });
  } catch (err) {
    console.error('Change password error:', err);
    res.status(500).json({ error: 'Could not change password.' });
  }
});

// ---------- GET CURRENT LOGGED-IN USER ----------
// GET /api/auth/me
// header: Authorization: Bearer <token>
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
    const { credential, role } = req.body;

    if (!credential) {
      return res.status(400).json({ error: 'Missing Google credential.' });
    }
    if (!process.env.GOOGLE_CLIENT_ID) {
      return res.status(500).json({ error: 'Google sign-in is not configured on this server yet.' });
    }

    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    const { sub: googleId, email, name } = payload;

    const [existing] = await db.query(
      'SELECT * FROM users WHERE google_id = ? OR email = ?',
      [googleId, email]
    );

    let user;

    if (existing.length > 0) {
      user = existing[0];
      if (!user.google_id) {
        await db.query('UPDATE users SET google_id = ? WHERE id = ?', [googleId, user.id]);
      }
    } else {
      if (!role || !['student', 'teacher'].includes(role)) {
        return res.status(400).json({ error: 'Please choose whether you are a student or a teacher first.' });
      }

      const [result] = await db.query(
        'INSERT INTO users (name, email, google_id, role) VALUES (?, ?, ?, ?)',
        [name, email, googleId, role]
      );
      const userId = result.insertId;

      if (role === 'student') {
        await db.query('INSERT INTO students (user_id) VALUES (?)', [userId]);
      } else {
        await db.query('INSERT INTO teachers (user_id, subjects) VALUES (?, ?)', [userId, '']);
      }

      const [newUserRows] = await db.query('SELECT * FROM users WHERE id = ?', [userId]);
      user = newUserRows[0];
    }

    const token = jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '7d' });
    setAuthCookie(res, token);

    res.json({
      message: 'Signed in with Google.',
      user: { id: user.id, name: user.name, email: user.email, role: user.role }
    });
  } catch (err) {
    console.error('Google sign-in error:', err);
    res.status(401).json({ error: 'Could not verify Google sign-in. Please try again.' });
  }
});

// ---------- VERIFY EMAIL ----------
// GET /api/auth/verify-email?token=...
// Public route — the link from the verification email hits this directly.
router.get('/verify-email', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) {
      return res.status(400).json({ error: 'Verification token is required.' });
    }

    const [rows] = await db.query(
      'SELECT id FROM users WHERE email_verify_token = ? AND email_verify_expires > NOW()',
      [token]
    );

    if (rows.length === 0) {
      return res.status(400).json({ error: 'This verification link is invalid or has expired. Please request a new one.' });
    }

    await db.query(
      'UPDATE users SET email_verified = 1, email_verify_token = NULL, email_verify_expires = NULL WHERE id = ?',
      [rows[0].id]
    );

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
    const [rows] = await db.query('SELECT email, email_verified FROM users WHERE id = ?', [req.user.id]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Account not found.' });
    }
    if (rows[0].email_verified) {
      return res.status(400).json({ error: 'Your email is already verified.' });
    }

    const newVerifyToken = crypto.randomBytes(32).toString('hex');
    const verifyExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await db.query(
      'UPDATE users SET email_verify_token = ?, email_verify_expires = ? WHERE id = ?',
      [newVerifyToken, verifyExpires, req.user.id]
    );

    const baseUrl = process.env.FRONTEND_URL || `${req.protocol}://${req.get('host')}`;
    const verifyLink = `${baseUrl}/verify-email.html?token=${newVerifyToken}`;
    const { subject, html } = emailTemplates.emailVerification(verifyLink);
    await sendMail({ to: rows[0].email, subject, html });

    res.json({ message: 'Verification email sent. Please check your inbox.' });
  } catch (err) {
    console.error('Resend verification error:', err);
    res.status(500).json({ error: 'Could not resend verification email.' });
  }
});

// ---------- LOGOUT ----------
// POST /api/auth/logout
// Clears the httpOnly cookie server-side — client-side JS has no way to
// remove an httpOnly cookie itself, so this endpoint is required for
// logout to actually invalidate the session rather than just forgetting
// the (non-existent, now) client-side copy of the token.
router.post('/logout', (req, res) => {
  res.clearCookie('token', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
  });
  res.json({ message: 'Logged out.' });
});

module.exports = router;