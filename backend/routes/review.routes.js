const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { verifyToken, requireRole } = require('../middleware/auth.middleware');

// ---------- LEAVE A REVIEW (protected: student, only for their own completed booking) ----------
// POST /api/reviews
// body: { booking_id, rating, comment }
router.post('/', verifyToken, requireRole('student'), async (req, res) => {
  try {
    const { booking_id, rating, comment } = req.body;

    if (!booking_id || !rating) {
      return res.status(400).json({ error: 'booking_id and rating are required.' });
    }
    if (rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Rating must be between 1 and 5.' });
    }

    // Confirm this booking belongs to the logged-in student, is completed,
    // and hasn't already been reviewed.
    const [bookingRows] = await db.query(
      `SELECT b.id, b.teacher_id, b.status
       FROM bookings b
       JOIN students s ON s.id = b.student_id
       WHERE b.id = ? AND s.user_id = ?`,
      [booking_id, req.user.id]
    );

    if (bookingRows.length === 0) {
      return res.status(403).json({ error: 'You can only review your own bookings.' });
    }
    if (bookingRows[0].status !== 'completed') {
      return res.status(400).json({ error: 'You can only review a class after it is marked completed.' });
    }

    const [existing] = await db.query('SELECT id FROM reviews WHERE booking_id = ?', [booking_id]);
    if (existing.length > 0) {
      return res.status(409).json({ error: 'You already reviewed this booking.' });
    }

    await db.query(
      'INSERT INTO reviews (booking_id, rating, comment) VALUES (?, ?, ?)',
      [booking_id, rating, comment || null]
    );

    // Recalculate this teacher's average rating + review count
    const teacherId = bookingRows[0].teacher_id;
    await db.query(
      `UPDATE teachers t
       SET
         rating_avg = (
           SELECT AVG(r.rating) FROM reviews r
           JOIN bookings b ON b.id = r.booking_id
           WHERE b.teacher_id = t.id
         ),
         total_reviews = (
           SELECT COUNT(*) FROM reviews r
           JOIN bookings b ON b.id = r.booking_id
           WHERE b.teacher_id = t.id
         )
       WHERE t.id = ?`,
      [teacherId]
    );

    res.status(201).json({ message: 'Review submitted. Thank you!' });
  } catch (err) {
    console.error('Create review error:', err);
    res.status(500).json({ error: 'Could not submit review.' });
  }
});

// ---------- GET REVIEWS FOR A TEACHER (public) ----------
// GET /api/reviews/teacher/:teacherId
router.get('/teacher/:teacherId', async (req, res) => {
  try {
    const { teacherId } = req.params;
    const [rows] = await db.query(
      `SELECT r.id, r.rating, r.comment, r.created_at,
              u.name AS student_name
       FROM reviews r
       JOIN bookings b ON b.id = r.booking_id
       JOIN students s ON s.id = b.student_id
       JOIN users u ON u.id = s.user_id
       WHERE b.teacher_id = ?
       ORDER BY r.created_at DESC`,
      [teacherId]
    );

    // Show only first name + last initial for a bit of privacy, e.g. "Priya S."
    const reviews = rows.map(r => ({
      ...r,
      student_name: r.student_name
        ? r.student_name.split(' ')[0] + (r.student_name.split(' ')[1] ? ' ' + r.student_name.split(' ')[1][0] + '.' : '')
        : 'Student',
    }));

    res.json(reviews);
  } catch (err) {
    console.error('Get teacher reviews error:', err);
    res.status(500).json({ error: 'Could not fetch reviews.' });
  }
});

module.exports = router;