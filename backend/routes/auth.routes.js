const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../config/db');
const { verifyToken } = require('../middleware/auth.middleware');

// ---------- SIGNUP ----------
// POST /api/auth/signup
// body: { name, email, phone, password, role: "student" | "teacher" }
router.post('/signup', async (req, res) => {
  try {
    const { name, email, phone, password, role } = req.body;

    if (!name || !email || !phone || !password || !role) {
      return res.status(400).json({ error: 'All fields are required.' });
    }
    if (!['student', 'teacher'].includes(role)) {
      return res.status(400).json({ error: 'Role must be student or teacher.' });
    }

    // Check if email already exists
    const [existing] = await db.query('SELECT id FROM users WHERE email = ?', [email]);
    if (existing.length > 0) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }

    const password_hash = await bcrypt.hash(password, 10);

    const [result] = await db.query(
      'INSERT INTO users (name, email, phone, password_hash, role) VALUES (?, ?, ?, ?, ?)',
      [name, email, phone, password_hash, role]
    );

    const userId = result.insertId;

    // Create the matching profile row
    if (role === 'student') {
      await db.query('INSERT INTO students (user_id) VALUES (?)', [userId]);
    } else if (role === 'teacher') {
      await db.query(
        'INSERT INTO teachers (user_id, subjects) VALUES (?, ?)',
        [userId, '']
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
    res.status(500).json({ error: 'Something went wrong during signup.' });
  }
});

// ---------- LOGIN ----------
// POST /api/auth/login
// body: { email, password }
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const [rows] = await db.query('SELECT * FROM users WHERE email = ?', [email]);
    if (rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const user = rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(401).json({ error: 'Invalid email or password.' });
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

module.exports = router;
