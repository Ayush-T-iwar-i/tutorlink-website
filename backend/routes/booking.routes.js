const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { verifyToken, requireRole } = require('../middleware/auth.middleware');

// ---------- CREATE A BOOKING (protected: must be a logged-in student) ----------
// POST /api/bookings
// header: Authorization: Bearer <token>
// body: { teacher_id, type, subject, booking_date, booking_time, days_per_week, fee }
router.post('/', verifyToken, requireRole('student'), async (req, res) => {
  try {
    const { teacher_id, type, subject, booking_date, booking_time, days_per_week, fee } = req.body;

    if (!teacher_id) {
      return res.status(400).json({ error: 'teacher_id is required.' });
    }

    // Look up the student's own student_id from their logged-in user id
    // (never trust a student_id sent from the client — always derive it from the token)
    const [studentRows] = await db.query('SELECT id FROM students WHERE user_id = ?', [req.user.id]);
    if (studentRows.length === 0) {
      return res.status(404).json({ error: 'Student profile not found.' });
    }
    const studentId = studentRows[0].id;

    const [result] = await db.query(
      `INSERT INTO bookings
        (student_id, teacher_id, type, subject, booking_date, booking_time, days_per_week, fee)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [studentId, teacher_id, type || 'demo', subject, booking_date, booking_time, days_per_week, fee || 0]
    );

    res.status(201).json({ message: 'Booking request sent.', booking_id: result.insertId });
  } catch (err) {
    console.error('Create booking error:', err);
    res.status(500).json({ error: 'Could not create booking.' });
  }
});

// ---------- TEACHER: ACCEPT / DECLINE A BOOKING (protected: must own this booking) ----------
// PUT /api/bookings/:id/status
// header: Authorization: Bearer <token>
// body: { status: "accepted" | "declined" | "completed" | "cancelled" }
router.put('/:id/status', verifyToken, requireRole('teacher'), async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const allowed = ['accepted', 'declined', 'completed', 'cancelled'];
    if (!allowed.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${allowed.join(', ')}` });
    }

    // Confirm this booking actually belongs to the logged-in teacher before updating
    const [rows] = await db.query(
      `SELECT b.id FROM bookings b
       JOIN teachers t ON t.id = b.teacher_id
       WHERE b.id = ? AND t.user_id = ?`,
      [id, req.user.id]
    );

    if (rows.length === 0) {
      return res.status(403).json({ error: 'You can only update your own booking requests.' });
    }

    await db.query('UPDATE bookings SET status = ? WHERE id = ?', [status, id]);
    res.json({ message: `Booking marked as ${status}.` });
  } catch (err) {
    console.error('Update booking status error:', err);
    res.status(500).json({ error: 'Could not update booking status.' });
  }
});

// ---------- GET ALL BOOKINGS FOR THE LOGGED-IN STUDENT ----------
// GET /api/bookings/student/me
router.get('/student/me', verifyToken, requireRole('student'), async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT b.*, u.name AS teacher_name
       FROM bookings b
       JOIN teachers t ON t.id = b.teacher_id
       JOIN users u ON u.id = t.user_id
       JOIN students s ON s.id = b.student_id
       WHERE s.user_id = ?
       ORDER BY b.created_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    console.error('Get student bookings error:', err);
    res.status(500).json({ error: 'Could not fetch bookings.' });
  }
});

// ---------- GET ALL BOOKINGS FOR THE LOGGED-IN TEACHER ----------
// GET /api/bookings/teacher/me
router.get('/teacher/me', verifyToken, requireRole('teacher'), async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT b.*, u.name AS student_name
       FROM bookings b
       JOIN students s ON s.id = b.student_id
       JOIN users u ON u.id = s.user_id
       JOIN teachers t ON t.id = b.teacher_id
       WHERE t.user_id = ?
       ORDER BY b.created_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    console.error('Get teacher bookings error:', err);
    res.status(500).json({ error: 'Could not fetch bookings.' });
  }
});

module.exports = router;
