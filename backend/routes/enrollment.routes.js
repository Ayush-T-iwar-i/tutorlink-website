const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { verifyToken, requireRole } = require('../middleware/auth.middleware');

// ---------- Helper: verify user is a participant of the enrollment ----------
async function verifyEnrollmentParticipant(enrollmentId, userId, userRole) {
  let query;
  if (userRole === 'student') {
    query = `SELECT e.* FROM enrollments e
             JOIN students s ON s.id = e.student_id
             WHERE e.id = ? AND s.user_id = ?`;
  } else if (userRole === 'teacher') {
    query = `SELECT e.* FROM enrollments e
             JOIN teachers t ON t.id = e.teacher_id
             WHERE e.id = ? AND t.user_id = ?`;
  } else {
    // Admin can access any enrollment
    query = `SELECT e.* FROM enrollments e WHERE e.id = ?`;
    const [rows] = await db.query(query, [enrollmentId]);
    return rows[0] || null;
  }
  const [rows] = await db.query(query, [enrollmentId, userId]);
  return rows[0] || null;
}

// ---------- GET MY ENROLLMENTS ----------
// GET /api/enrollments?status=active
router.get('/', verifyToken, async (req, res) => {
  try {
    const { status } = req.query;
    let query, params;

    if (req.user.role === 'student') {
      query = `
        SELECT e.*, u_teacher.name AS teacher_name, u_teacher.profile_photo AS teacher_photo,
               t.subjects AS teacher_subjects, t.qualification AS teacher_qualification,
               (SELECT COUNT(*) FROM courses WHERE enrollment_id = e.id) AS course_count
        FROM enrollments e
        JOIN teachers t ON t.id = e.teacher_id
        JOIN users u_teacher ON u_teacher.id = t.user_id
        JOIN students s ON s.id = e.student_id
        WHERE s.user_id = ?`;
      params = [req.user.id];
    } else if (req.user.role === 'teacher') {
      query = `
        SELECT e.*, u_student.name AS student_name, u_student.profile_photo AS student_photo,
               st.preferred_grade AS student_grade,
               (SELECT COUNT(*) FROM courses WHERE enrollment_id = e.id) AS course_count
        FROM enrollments e
        JOIN students st ON st.id = e.student_id
        JOIN users u_student ON u_student.id = st.user_id
        JOIN teachers t ON t.id = e.teacher_id
        WHERE t.user_id = ?`;
      params = [req.user.id];
    } else {
      return res.status(403).json({ error: 'Invalid role for this endpoint.' });
    }

    if (status && ['active', 'paused', 'completed', 'cancelled'].includes(status)) {
      query += ' AND e.status = ?';
      params.push(status);
    }

    query += ' ORDER BY e.created_at DESC';

    const [rows] = await db.query(query, params);
    res.json(rows);
  } catch (err) {
    console.error('Get enrollments error:', err);
    res.status(500).json({ error: 'Could not fetch enrollments.' });
  }
});

// ---------- GET SINGLE ENROLLMENT ----------
// GET /api/enrollments/:id
router.get('/:id', verifyToken, async (req, res) => {
  try {
    const enrollment = await verifyEnrollmentParticipant(req.params.id, req.user.id, req.user.role);
    if (!enrollment) {
      return res.status(404).json({ error: 'Enrollment not found or access denied.' });
    }

    // Enrich with names
    const [enriched] = await db.query(
      `SELECT e.*,
              u_student.name AS student_name, u_student.profile_photo AS student_photo, u_student.email AS student_email,
              u_teacher.name AS teacher_name, u_teacher.profile_photo AS teacher_photo, u_teacher.email AS teacher_email,
              t.subjects AS teacher_subjects, t.qualification AS teacher_qualification, t.fee_per_hour,
              st.preferred_grade AS student_grade
       FROM enrollments e
       JOIN students st ON st.id = e.student_id
       JOIN users u_student ON u_student.id = st.user_id
       JOIN teachers t ON t.id = e.teacher_id
       JOIN users u_teacher ON u_teacher.id = t.user_id
       WHERE e.id = ?`,
      [req.params.id]
    );

    if (enriched.length === 0) {
      return res.status(404).json({ error: 'Enrollment not found.' });
    }

    res.json(enriched[0]);
  } catch (err) {
    console.error('Get enrollment error:', err);
    res.status(500).json({ error: 'Could not fetch enrollment.' });
  }
});

// ---------- TEACHER: UPDATE ENROLLMENT STATUS ----------
// PUT /api/enrollments/:id/status
// body: { status: "active" | "paused" | "completed" | "cancelled", notes }
router.put('/:id/status', verifyToken, requireRole('teacher'), async (req, res) => {
  try {
    const { status, notes } = req.body;
    const allowed = ['active', 'paused', 'completed', 'cancelled'];
    if (!allowed.includes(status)) {
      return res.status(400).json({ error: `Status must be one of: ${allowed.join(', ')}` });
    }

    const enrollment = await verifyEnrollmentParticipant(req.params.id, req.user.id, req.user.role);
    if (!enrollment) {
      return res.status(403).json({ error: 'You can only update your own enrollments.' });
    }

    const updates = ['status = ?'];
    const params = [status];

    if (notes !== undefined) {
      updates.push('notes = ?');
      params.push(notes);
    }

    if (status === 'completed' && !enrollment.end_date) {
      updates.push('end_date = CURDATE()');
    }

    params.push(req.params.id);
    await db.query(`UPDATE enrollments SET ${updates.join(', ')} WHERE id = ?`, params);

    // If completing, also complete associated courses
    if (status === 'completed') {
      await db.query(
        `UPDATE courses SET status = 'completed' WHERE enrollment_id = ? AND status = 'active'`,
        [req.params.id]
      );
    }

    // Notify the student
    const { createNotification } = require('./notification.routes');
    const [studentUser] = await db.query(
      `SELECT s.user_id FROM enrollments e JOIN students s ON s.id = e.student_id WHERE e.id = ?`,
      [req.params.id]
    );
    if (studentUser.length > 0) {
      const statusMessages = {
        active: 'Your tuition has been resumed.',
        paused: 'Your tuition has been paused by the teacher.',
        completed: 'Congratulations! Your tuition has been marked as completed.',
        cancelled: 'Your tuition has been cancelled.',
      };
      await createNotification(studentUser[0].user_id, statusMessages[status], 'courses.html');
    }

    res.json({ message: `Enrollment marked as ${status}.` });
  } catch (err) {
    console.error('Update enrollment status error:', err);
    res.status(500).json({ error: 'Could not update enrollment status.' });
  }
});

module.exports = router;
module.exports.verifyEnrollmentParticipant = verifyEnrollmentParticipant;
