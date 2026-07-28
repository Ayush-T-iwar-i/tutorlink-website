const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { verifyToken } = require('../middleware/auth.middleware');

const REASONS = ['no_show', 'inappropriate_behaviour', 'payment_issue', 'fake_profile', 'other'];

// ---------- FILE A REPORT ----------
// POST /api/reports
// body: { booking_id (optional), reported_user_id, reason, details }
router.post('/', verifyToken, async (req, res) => {
  try {
    const { booking_id, reported_user_id, reason, details } = req.body;

    if (!reported_user_id || !reason) {
      return res.status(400).json({ error: 'reported_user_id and reason are required.' });
    }
    if (!REASONS.includes(reason)) {
      return res.status(400).json({ error: `reason must be one of: ${REASONS.join(', ')}` });
    }
    if (Number(reported_user_id) === req.user.id) {
      return res.status(400).json({ error: 'You cannot report yourself.' });
    }

    // If a booking_id was given, confirm the reporter was actually part of it
    if (booking_id) {
      const [rows] = await db.query(
        `SELECT s.user_id AS student_user_id, t.user_id AS teacher_user_id
         FROM bookings b
         JOIN students s ON s.id = b.student_id
         JOIN teachers t ON t.id = b.teacher_id
         WHERE b.id = ?`,
        [booking_id]
      );
      if (rows.length === 0) return res.status(404).json({ error: 'Booking not found.' });
      const isParticipant = req.user.id === rows[0].student_user_id || req.user.id === rows[0].teacher_user_id;
      if (!isParticipant) return res.status(403).json({ error: 'You were not part of this booking.' });
    }

    await db.query(
      'INSERT INTO reports (reporter_user_id, reported_user_id, booking_id, reason, details) VALUES (?, ?, ?, ?, ?)',
      [req.user.id, reported_user_id, booking_id || null, reason, details || null]
    );

    res.status(201).json({ message: 'Report submitted. Our team will review it shortly.' });
  } catch (err) {
    console.error('File report error:', err);
    res.status(500).json({ error: 'Could not submit report.' });
  }
});

module.exports = router;