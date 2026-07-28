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

// ---------- LIST REPORTS ----------
// GET /api/admin/reports?status=open
router.get('/reports', verifyToken, requireRole('admin'), async (req, res) => {
  try {
    const { status } = req.query;
    let query = `
      SELECT r.*, ru.name AS reporter_name, tu.name AS reported_name
      FROM reports r
      JOIN users ru ON ru.id = r.reporter_user_id
      JOIN users tu ON tu.id = r.reported_user_id`;
    const params = [];
    if (status) { query += ' WHERE r.status = ?'; params.push(status); }
    query += ' ORDER BY r.created_at DESC';

    const [rows] = await db.query(query, params);
    res.json(rows);
  } catch (err) {
    console.error('List reports error:', err);
    res.status(500).json({ error: 'Could not fetch reports.' });
  }
});

// ---------- UPDATE REPORT STATUS ----------
// PUT /api/admin/reports/:id
// body: { status: "reviewed" | "resolved", admin_notes }
router.put('/reports/:id', verifyToken, requireRole('admin'), async (req, res) => {
  try {
    const { status, admin_notes } = req.body;
    const allowed = ['open', 'reviewed', 'resolved'];
    if (!allowed.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${allowed.join(', ')}` });
    }
    await db.query('UPDATE reports SET status = ?, admin_notes = ? WHERE id = ?', [status, admin_notes || null, req.params.id]);
    res.json({ message: `Report marked as ${status}.` });
  } catch (err) {
    console.error('Update report error:', err);
    res.status(500).json({ error: 'Could not update report.' });
  }
});

// ---------- SIGNUPS PER DAY (last 14 days, for a simple chart) ----------
// GET /api/admin/stats/signups-by-day
router.get('/stats/signups-by-day', verifyToken, requireRole('admin'), async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT DATE(created_at) AS day, COUNT(*) AS count
       FROM users
       WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 13 DAY)
       GROUP BY DATE(created_at)
       ORDER BY day ASC`
    );

    // Fill in any missing days with 0 so the chart doesn't have gaps
    const byDay = {};
    rows.forEach(r => { byDay[r.day.toISOString().split('T')[0]] = r.count; });

    const result = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = d.toISOString().split('T')[0];
      result.push({ day: key, count: byDay[key] || 0 });
    }

    res.json(result);
  } catch (err) {
    console.error('Get signups-by-day error:', err);
    res.status(500).json({ error: 'Could not fetch signup trend.' });
  }
});

// ---------- CSV EXPORTS ----------
function toCsv(rows, columns) {
  const header = columns.join(',');
  const body = rows.map(row =>
    columns.map(col => {
      const val = row[col] === null || row[col] === undefined ? '' : String(row[col]);
      // Escape quotes/commas per standard CSV rules
      return `"${val.replace(/"/g, '""')}"`;
    }).join(',')
  ).join('\n');
  return `${header}\n${body}`;
}

// GET /api/admin/export/students
router.get('/export/students', verifyToken, requireRole('admin'), async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT u.id, u.name, u.email, u.phone, s.city, s.preferred_subjects, s.preferred_grade, u.created_at
       FROM users u JOIN students s ON s.user_id = u.id
       WHERE u.role = 'student'
       ORDER BY u.created_at DESC`
    );
    const csv = toCsv(rows, ['id','name','email','phone','city','preferred_subjects','preferred_grade','created_at']);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="students.csv"');
    res.send(csv);
  } catch (err) {
    console.error('Export students error:', err);
    res.status(500).json({ error: 'Could not export students.' });
  }
});

// GET /api/admin/export/teachers
router.get('/export/teachers', verifyToken, requireRole('admin'), async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT u.id, u.name, u.email, u.phone, t.city, t.subjects, t.qualification,
              t.fee_per_hour, t.verification_status, t.rating_avg, t.total_reviews, u.created_at
       FROM users u JOIN teachers t ON t.user_id = u.id
       WHERE u.role = 'teacher'
       ORDER BY u.created_at DESC`
    );
    const csv = toCsv(rows, ['id','name','email','phone','city','subjects','qualification','fee_per_hour','verification_status','rating_avg','total_reviews','created_at']);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="teachers.csv"');
    res.send(csv);
  } catch (err) {
    console.error('Export teachers error:', err);
    res.status(500).json({ error: 'Could not export teachers.' });
  }
});

module.exports = router;