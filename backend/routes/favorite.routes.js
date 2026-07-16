const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { verifyToken, requireRole } = require('../middleware/auth.middleware');

async function getStudentId(userId) {
  const [rows] = await db.query('SELECT id FROM students WHERE user_id = ?', [userId]);
  return rows[0]?.id || null;
}

// ---------- LIST MY SAVED TEACHERS ----------
// GET /api/favorites/me
router.get('/me', verifyToken, requireRole('student'), async (req, res) => {
  try {
    const studentId = await getStudentId(req.user.id);
    if (!studentId) return res.json([]);

    const [rows] = await db.query(
      `SELECT t.id, u.name, t.subjects, t.qualification, t.fee_per_hour,
              t.rating_avg, t.total_reviews, t.city, f.created_at AS saved_at
       FROM favorites f
       JOIN teachers t ON t.id = f.teacher_id
       JOIN users u ON u.id = t.user_id
       WHERE f.student_id = ?
       ORDER BY f.created_at DESC`,
      [studentId]
    );
    res.json(rows);
  } catch (err) {
    console.error('Get favorites error:', err);
    res.status(500).json({ error: 'Could not fetch saved teachers.' });
  }
});

// ---------- SAVE A TEACHER ----------
// POST /api/favorites
// body: { teacher_id }
router.post('/', verifyToken, requireRole('student'), async (req, res) => {
  try {
    const { teacher_id } = req.body;
    if (!teacher_id) return res.status(400).json({ error: 'teacher_id is required.' });

    const studentId = await getStudentId(req.user.id);
    if (!studentId) return res.status(400).json({ error: 'Complete your student profile first.' });

    await db.query(
      'INSERT IGNORE INTO favorites (student_id, teacher_id) VALUES (?, ?)',
      [studentId, teacher_id]
    );
    res.status(201).json({ message: 'Teacher saved.' });
  } catch (err) {
    console.error('Save favorite error:', err);
    res.status(500).json({ error: 'Could not save teacher.' });
  }
});

// ---------- REMOVE A SAVED TEACHER ----------
// DELETE /api/favorites/:teacherId
router.delete('/:teacherId', verifyToken, requireRole('student'), async (req, res) => {
  try {
    const studentId = await getStudentId(req.user.id);
    if (!studentId) return res.status(400).json({ error: 'Complete your student profile first.' });

    await db.query(
      'DELETE FROM favorites WHERE student_id = ? AND teacher_id = ?',
      [studentId, req.params.teacherId]
    );
    res.json({ message: 'Removed from saved teachers.' });
  } catch (err) {
    console.error('Remove favorite error:', err);
    res.status(500).json({ error: 'Could not remove teacher.' });
  }
});

module.exports = router;