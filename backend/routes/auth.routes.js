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

// ---------- SIGNUP ----------
// POST /api/auth/signup
// body (common): { name, email, phone, password, role: "student" | "teacher" }
// body (student, optional): { preferred_grade, preferred_subjects }
// body (teacher, optional): { subjects, qualification, experience_years }
router.post('/signup', [
  body('name').trim().isLength({ min: 2 }).withMessage('Please enter your full name.'),
  body('email').trim().isEmail().withMessage('Please enter a valid email address.').normalizeEmail(),
  body('phone').trim().matches(/^[6-9]\d{9}$/).withMessage('Please enter a valid 10-digit Indian mobile number.'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters.'),
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

    // Check if email or phone already exists (two separate checks so we
    // can tell the person exactly which one is the problem)
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

    // Create the matching profile row — save whatever the signup form
    // already collected, so the person doesn't have to retype it on the
    // complete-profile page.
    if (role === 'student') {
      await db.query(
        'INSERT INTO students (user_id, preferred_grade, preferred_subjects) VALUES (?, ?, ?)',
        [userId, preferred_grade || null, preferred_subjects || null]
      );
    } else if (role === 'teacher') {
      await db.query(
        'INSERT INTO teachers (user_id, subjects, qualification, experience_years) VALUES (?, ?, ?, ?)',
        [userId, subjects || '', qualification || null, experience_years || 0]
      );
    }

    const token = jwt.sign({ id: userId, role }, process.env.JWT_SECRET, { expiresIn: '7d' });

    res.status(201).json({
      message: 'Account created successfully.',
      token,
      user: { id: userId, name, email, role }
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

    // Locked out? Tell them how much longer, without revealing anything else.
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

    // Successful login — reset the counter
    if (user.failed_login_attempts > 0 || user.locked_until) {
      await db.query('UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = ?', [user.id]);
    }

    const token = jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '7d' });

    res.json({
      message: 'Login successful.',
      token,
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
// Always responds with the same generic message whether or not the email
// exists — this prevents attackers from using this endpoint to find out
// which emails are registered on TutorLink.
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'Email is required.' });
    }

    const [rows] = await db.query('SELECT id FROM users WHERE email = ?', [email]);

    if (rows.length > 0) {
      const resetToken = crypto.randomBytes(32).toString('hex');
      const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

      await db.query(
        'UPDATE users SET reset_token = ?, reset_token_expires = ? WHERE id = ?',
        [resetToken, expires, rows[0].id]
      );

      const resetLink = `${process.env.FRONTEND_URL || ''}/reset-password.html?token=${resetToken}`;

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
router.post('/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) {
      return res.status(400).json({ error: 'Token and new password are required.' });
    }

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
  body('new_password').isLength({ min: 6 }).withMessage('New password must be at least 6 characters.'),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ error: errors.array()[0].msg });
  }

  try {
    const { current_password, new_password } = req.body;
    if (!current_password) {
      return res.status(400).json({ error: 'Please enter your current password.' });
    }

    const [rows] = await db.query('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Account not found.' });

    // Google-only accounts have no password_hash yet — guide them instead of a confusing failure
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

// ---------- GET CURRENT LOGGED-IN USER (used to check if a session is still valid) ----------
// GET /api/auth/me
// header: Authorization: Bearer <token>
router.get('/me', verifyToken, async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT id, name, email, phone, role, profile_photo FROM users WHERE id = ?',
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
// body: { credential, role }  — role is only required the first time (signup)
router.post('/google', async (req, res) => {
  try {
    const { credential, role } = req.body;

    if (!credential) {
      return res.status(400).json({ error: 'Missing Google credential.' });
    }
    if (!process.env.GOOGLE_CLIENT_ID) {
      return res.status(500).json({ error: 'Google sign-in is not configured on this server yet.' });
    }

    // Verify the token actually came from Google and wasn't tampered with
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    const { sub: googleId, email, name } = payload;

    // Check if this Google account (or this email) already has a TutorLink account
    const [existing] = await db.query(
      'SELECT * FROM users WHERE google_id = ? OR email = ?',
      [googleId, email]
    );

    let user;

    if (existing.length > 0) {
      // Existing user — just log them in
      user = existing[0];

      // Link the Google ID if they'd originally signed up with email/password
      if (!user.google_id) {
        await db.query('UPDATE users SET google_id = ? WHERE id = ?', [googleId, user.id]);
      }
    } else {
      // New user — role is required to create the account
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

    res.json({
      message: 'Signed in with Google.',
      token,
      user: { id: user.id, name: user.name, email: user.email, role: user.role }
    });
  } catch (err) {
    console.error('Google sign-in error:', err);
    res.status(401).json({ error: 'Could not verify Google sign-in. Please try again.' });
  }
});

module.exports = router;