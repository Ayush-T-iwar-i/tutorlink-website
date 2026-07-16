const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { verifyToken, requireRole } = require('../middleware/auth.middleware');

// ---------- LIST TEACHERS AWAITING APPROVAL ----------
// GET /api/admin/teachers/pending
router.get('/teachers/pending', verifyToken, requireRole('admin'), async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT t.id, u.name, u.email, u.phone, t.qualification, t.subjects,
              t.experience_years, t.address, t.city, t.verification_status, t.created_at
       FROM teachers t JOIN users u ON u.id = t.user_id
       WHERE t.verification_status IN ('pending', 'under_review')
       ORDER BY t.created_at ASC`
    );
    res.json(rows);
  } catch (err) {
    console.error('List pending teachers error:', err);
    res.status(500).json({ error: 'Could not fetch pending teachers.' });
  }
});

// ---------- APPROVE / REJECT A TEACHER ----------
// PUT /api/admin/teachers/:id/verification
// body: { status: "approved" | "rejected" | "under_review" }
router.put('/teachers/:id/verification', verifyToken, requireRole('admin'), async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const allowed = ['pending', 'under_review', 'approved', 'rejected'];

    if (!allowed.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${allowed.join(', ')}` });
    }

    const [result] = await db.query(
      'UPDATE teachers SET verification_status = ? WHERE id = ?',
      [status, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Teacher not found.' });
    }

    res.json({ message: `Teacher marked as ${status}.` });
  } catch (err) {
    console.error('Update verification error:', err);
    res.status(500).json({ error: 'Could not update verification status.' });
  }
});

// ---------- SITE-WIDE STATS ----------
// GET /api/admin/stats
router.get('/stats', verifyToken, requireRole('admin'), async (req, res) => {
  try {
    const [[{ total_students }]] = await db.query("SELECT COUNT(*) AS total_students FROM users WHERE role = 'student'");
    const [[{ total_teachers }]] = await db.query("SELECT COUNT(*) AS total_teachers FROM users WHERE role = 'teacher'");
    const [[{ approved_teachers }]] = await db.query("SELECT COUNT(*) AS approved_teachers FROM teachers WHERE verification_status = 'approved'");
    const [[{ pending_teachers }]] = await db.query("SELECT COUNT(*) AS pending_teachers FROM teachers WHERE verification_status IN ('pending','under_review')");
    const [[{ total_bookings }]] = await db.query('SELECT COUNT(*) AS total_bookings FROM bookings');
    const [[{ completed_bookings }]] = await db.query("SELECT COUNT(*) AS completed_bookings FROM bookings WHERE status = 'completed'");
    const [[{ signups_last_7_days }]] = await db.query(
      'SELECT COUNT(*) AS signups_last_7_days FROM users WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)'
    );

    res.json({
      total_students, total_teachers, approved_teachers, pending_teachers,
      total_bookings, completed_bookings, signups_last_7_days,
    });
  } catch (err) {
    console.error('Get admin stats error:', err);
    res.status(500).json({ error: 'Could not fetch stats.' });
  }
});

module.exports = router;