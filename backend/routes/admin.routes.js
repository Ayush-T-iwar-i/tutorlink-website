const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { verifyToken, requireRole } = require('../middleware/auth.middleware');
const { refundAndNotify } = require('../lib/payment-jobs');
const sessions = require('../lib/sessions');

const REPORT_STATUSES = ['open', 'reviewed', 'resolved'];
const USER_ROLES = ['student', 'teacher', 'admin'];
const USER_PAGE_SIZE = 25;

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
    if (status !== undefined && !REPORT_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${REPORT_STATUSES.join(', ')}`, code: 'VALIDATION_ERROR' });
    }
    let query = `
      SELECT r.*, ru.name AS reporter_name, tu.name AS reported_name
      FROM reports r
      JOIN users ru ON ru.id = r.reporter_user_id
      JOIN users tu ON tu.id = r.reported_user_id`;
    const params = [];
    if (status) { query += ' WHERE r.status = ?'; params.push(status); }
    query += ' ORDER BY r.created_at DESC LIMIT 200';

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
    const { status, admin_notes } = req.body || {};
    if (!REPORT_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${REPORT_STATUSES.join(', ')}`, code: 'VALIDATION_ERROR' });
    }
    if (admin_notes != null && (typeof admin_notes !== 'string' || admin_notes.length > 2000)) {
      return res.status(400).json({ error: 'admin_notes must be text of at most 2000 characters.', code: 'VALIDATION_ERROR' });
    }
    const [result] = await db.query('UPDATE reports SET status = ?, admin_notes = ? WHERE id = ?', [status, admin_notes || null, req.params.id]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Report not found.', code: 'NOT_FOUND' });
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
    rows.forEach(r => {
      const dayKey = r.day instanceof Date
        ? r.day.toISOString().split('T')[0]
        : String(r.day || '').split('T')[0];
      if (dayKey) byDay[dayKey] = r.count;
    });

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


// ---------- USER MANAGEMENT ----------
// GET /api/admin/users?role=student|teacher|admin&status=active|suspended&q=<name/email/phone>&page=1
router.get('/users', verifyToken, requireRole('admin'), async (req, res) => {
  try {
    const { role, status } = req.query;
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
    const page = Math.min(Math.max(parseInt(req.query.page, 10) || 1, 1), 10000);
    if (role !== undefined && role !== '' && !USER_ROLES.includes(role)) {
      return res.status(400).json({ error: `role must be one of: ${USER_ROLES.join(', ')}`, code: 'VALIDATION_ERROR' });
    }
    if (status !== undefined && status !== '' && !['active', 'suspended'].includes(status)) {
      return res.status(400).json({ error: 'status must be active or suspended', code: 'VALIDATION_ERROR' });
    }

    const where = [];
    const params = [];
    if (role) { where.push('u.role = ?'); params.push(role); }
    if (status === 'active') where.push('u.suspended_at IS NULL');
    if (status === 'suspended') where.push('u.suspended_at IS NOT NULL');
    if (q) {
      const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      where.push('(u.name LIKE ? OR u.email LIKE ? OR u.phone LIKE ?)');
      params.push(like, like, like);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [[{ total }]] = await db.query(`SELECT COUNT(*) AS total FROM users u ${whereSql}`, params);
    const [users] = await db.query(
      `SELECT u.id, u.name, u.email, u.phone, u.role, u.email_verified, u.created_at,
              u.suspended_at, u.suspended_reason, t.verification_status
       FROM users u
       LEFT JOIN teachers t ON t.user_id = u.id
       ${whereSql}
       ORDER BY u.created_at DESC, u.id DESC
       LIMIT ? OFFSET ?`,
      [...params, USER_PAGE_SIZE, (page - 1) * USER_PAGE_SIZE]
    );
    res.json({ users, page, pageSize: USER_PAGE_SIZE, total, totalPages: Math.max(1, Math.ceil(total / USER_PAGE_SIZE)) });
  } catch (err) {
    console.error('List users error:', err);
    res.status(500).json({ error: 'Could not fetch users.' });
  }
});

async function loadManageableUser(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    res.status(400).json({ error: 'Invalid user id.', code: 'VALIDATION_ERROR' });
    return null;
  }
  if (id === req.user.id) {
    res.status(400).json({ error: 'You cannot change your own account status.', code: 'VALIDATION_ERROR' });
    return null;
  }
  const [rows] = await db.query('SELECT id, name, role, suspended_at FROM users WHERE id = ?', [id]);
  if (rows.length === 0) {
    res.status(404).json({ error: 'User not found.', code: 'NOT_FOUND' });
    return null;
  }
  if (rows[0].role === 'admin') {
    res.status(403).json({ error: 'Admin accounts cannot be suspended here.', code: 'FORBIDDEN' });
    return null;
  }
  return rows[0];
}

// POST /api/admin/users/:id/suspend   body: { reason }
// Blocks login and ends every active session of the user immediately.
router.post('/users/:id/suspend', verifyToken, requireRole('admin'), async (req, res) => {
  try {
    const reason = req.body && req.body.reason;
    if (typeof reason !== 'string' || !reason.trim() || reason.trim().length > 255) {
      return res.status(400).json({ error: 'Please give a reason (at most 255 characters).', code: 'VALIDATION_ERROR' });
    }
    const user = await loadManageableUser(req, res);
    if (!user) return;
    if (user.suspended_at) return res.status(409).json({ error: 'This account is already suspended.', code: 'CONFLICT' });

    await db.query('UPDATE users SET suspended_at = NOW(), suspended_reason = ? WHERE id = ? AND suspended_at IS NULL', [reason.trim(), user.id]);
    await sessions.revokeAllUserSessions(db, user.id, 'suspended');
    console.log(`[admin] user ${user.id} suspended by admin ${req.user.id}`);
    res.json({ message: `${user.name} has been suspended.` });
  } catch (err) {
    console.error('Suspend user error:', err);
    res.status(500).json({ error: 'Could not suspend user.' });
  }
});

// POST /api/admin/users/:id/reactivate
router.post('/users/:id/reactivate', verifyToken, requireRole('admin'), async (req, res) => {
  try {
    const user = await loadManageableUser(req, res);
    if (!user) return;
    if (!user.suspended_at) return res.status(409).json({ error: 'This account is not suspended.', code: 'CONFLICT' });
    await db.query('UPDATE users SET suspended_at = NULL, suspended_reason = NULL WHERE id = ?', [user.id]);
    console.log(`[admin] user ${user.id} reactivated by admin ${req.user.id}`);
    res.json({ message: `${user.name} has been reactivated.` });
  } catch (err) {
    console.error('Reactivate user error:', err);
    res.status(500).json({ error: 'Could not reactivate user.' });
  }
});

// ---------- CSV EXPORTS ----------
function toCsv(rows, columns) {
  const header = columns.join(',');
  const body = rows.map(row =>
    columns.map(col => {
      let val = row[col] === null || row[col] === undefined ? '' : String(row[col]);
      // A leading = + - @ (or tab/CR) makes Excel/Sheets run the cell as a formula: neutralise it.
      if (/^[=+\-@\t\r]/.test(val)) val = `'${val}`;
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

// ---------- LIST PAYMENTS ----------
// GET /api/admin/payments?status=duplicate&page=1
router.get('/payments', verifyToken, requireRole('admin'), async (req, res) => {
  try {
    const statuses = ['created', 'paid', 'refund_pending', 'refunded', 'void', 'duplicate'];
    const status = req.query.status;
    if (status !== undefined && !statuses.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${statuses.join(', ')}`, code: 'VALIDATION_ERROR' });
    }
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = 50;
    const where = status ? 'WHERE p.status = ?' : '';
    const params = status ? [status] : [];
    const [rows] = await db.query(
      `SELECT p.id, p.booking_id, p.method, p.status, p.amount_paise, p.currency, p.failure_reason,
              p.razorpay_order_id, p.razorpay_payment_id, p.razorpay_refund_id, p.paid_at, p.refunded_at, p.created_at,
              su.name AS student_name, tu.name AS teacher_name
       FROM payments p
       JOIN bookings b ON b.id = p.booking_id
       JOIN students s ON s.id = b.student_id JOIN users su ON su.id = s.user_id
       JOIN teachers t ON t.id = b.teacher_id JOIN users tu ON tu.id = t.user_id
       ${where}
       ORDER BY p.id DESC LIMIT ? OFFSET ?`,
      [...params, pageSize, (page - 1) * pageSize]
    );
    res.json({ page, page_size: pageSize, payments: rows });
  } catch (err) {
    console.error('List payments error:', err);
    res.status(500).json({ error: 'Could not fetch payments.', code: 'INTERNAL_ERROR' });
  }
});

// ---------- REFUND (or retry a stuck refund) ----------
// POST /api/admin/payments/:id/refund
// Works for online payments in state paid / refund_pending / duplicate. Cash payments cannot be refunded here.
router.post('/payments/:id/refund', verifyToken, requireRole('admin'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid payment id.', code: 'VALIDATION_ERROR' });

    const [rows] = await db.query('SELECT id, method, status FROM payments WHERE id = ?', [id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Payment not found.', code: 'NOT_FOUND' });
    const p = rows[0];
    if (p.method !== 'razorpay') return res.status(409).json({ error: 'Cash payments are settled between teacher and student.', code: 'MANUAL_PAYMENT' });
    if (!['paid', 'refund_pending', 'duplicate'].includes(p.status)) {
      return res.status(409).json({ error: `A payment in state '${p.status}' cannot be refunded.`, code: 'INVALID_STATE' });
    }
    if (p.status === 'paid') {
      // Atomic claim: only one admin click can move paid -> refund_pending.
      const [claim] = await db.query("UPDATE payments SET status = 'refund_pending' WHERE id = ? AND status = 'paid'", [id]);
      if (claim.affectedRows === 0) return res.status(409).json({ error: 'This payment was just changed. Reload and try again.', code: 'INVALID_STATE' });
    }
    const result = await refundAndNotify(id, 'admin_refund');
    if (result.outcome === 'refunded') return res.json({ message: 'Refund issued.', outcome: result.outcome });
    if (result.outcome === 'nothing_to_do') {
      // Another request (or the gateway webhook) finished this refund first.
      return res.status(409).json({ error: 'This payment was already refunded or is being refunded.', code: 'INVALID_STATE' });
    }
    res.status(502).json({ error: 'The refund could not be completed yet. It stays pending and can be retried.', code: 'REFUND_PENDING', outcome: result.outcome });
  } catch (err) {
    console.error('Admin refund error:', err);
    res.status(500).json({ error: 'Could not process refund.', code: 'INTERNAL_ERROR' });
  }
});

module.exports = router;module.exports.toCsv = toCsv;
