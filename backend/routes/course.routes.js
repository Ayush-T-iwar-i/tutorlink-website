const express = require('express');
const router = express.Router();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Throws ValidationError for a non-text/blank/too-long title or a malformed/out-of-order date.
function validateTextAndDates({ title, start_date, end_date }) {
  if (title !== undefined && (typeof title !== 'string' || !title.trim() || title.trim().length > 255)) {
    throw new ValidationError('Title must be non-empty text of at most 255 characters.');
  }
  for (const [label, d] of [['start_date', start_date], ['end_date', end_date]]) {
    if (d !== undefined && d !== null && d !== '' && (typeof d !== 'string' || !DATE_RE.test(d) || Number.isNaN(Date.parse(d)))) {
      throw new ValidationError(`${label} must be a date in YYYY-MM-DD format.`);
    }
  }
  if (start_date && end_date && end_date < start_date) {
    throw new ValidationError('end_date cannot be before start_date.');
  }
}
const db = require('../config/db');
const { ValidationError, optionalText, sendValidationError } = require('../lib/validate');
const { verifyToken, requireRole } = require('../middleware/auth.middleware');
const { verifyEnrollmentParticipant } = require('./enrollment.routes');

// ---------- Helper: verify user is a participant of the course ----------
async function verifyCourseParticipant(courseId, userId, userRole) {
  const [rows] = await db.query(
    `SELECT c.*, e.student_id, e.teacher_id
     FROM courses c
     JOIN enrollments e ON e.id = c.enrollment_id
     WHERE c.id = ?`,
    [courseId]
  );
  if (rows.length === 0) return null;

  const course = rows[0];

  if (userRole === 'admin') return course;

  if (userRole === 'student') {
    const [check] = await db.query(
      'SELECT id FROM students WHERE id = ? AND user_id = ?',
      [course.student_id, userId]
    );
    return check.length > 0 ? course : null;
  }

  if (userRole === 'teacher') {
    const [check] = await db.query(
      'SELECT id FROM teachers WHERE id = ? AND user_id = ?',
      [course.teacher_id, userId]
    );
    return check.length > 0 ? course : null;
  }

  return null;
}

// ---------- Helper: verify teacher owns the course ----------
async function verifyCourseTeacher(courseId, userId) {
  const [rows] = await db.query(
    `SELECT c.id FROM courses c
     JOIN enrollments e ON e.id = c.enrollment_id
     JOIN teachers t ON t.id = e.teacher_id
     WHERE c.id = ? AND t.user_id = ?`,
    [courseId, userId]
  );
  return rows.length > 0;
}

// ---------- GET MY COURSES ----------
// GET /api/courses?status=active&enrollment_id=5
router.get('/', verifyToken, async (req, res) => {
  try {
    const { status, enrollment_id } = req.query;
    let query, params;

    if (req.user.role === 'student') {
      query = `
        SELECT c.*, e.subject AS enrollment_subject, e.status AS enrollment_status,
               u_teacher.name AS teacher_name, u_teacher.profile_photo AS teacher_photo,
               t.subjects AS teacher_subjects,
               (SELECT COUNT(*) FROM course_modules WHERE course_id = c.id) AS module_count
        FROM courses c
        JOIN enrollments e ON e.id = c.enrollment_id
        JOIN teachers t ON t.id = e.teacher_id
        JOIN users u_teacher ON u_teacher.id = t.user_id
        JOIN students s ON s.id = e.student_id
        WHERE s.user_id = ?`;
      params = [req.user.id];
    } else if (req.user.role === 'teacher') {
      query = `
        SELECT c.*, e.subject AS enrollment_subject, e.status AS enrollment_status,
               u_student.name AS student_name, u_student.profile_photo AS student_photo,
               st.preferred_grade AS student_grade,
               (SELECT COUNT(*) FROM course_modules WHERE course_id = c.id) AS module_count
        FROM courses c
        JOIN enrollments e ON e.id = c.enrollment_id
        JOIN students st ON st.id = e.student_id
        JOIN users u_student ON u_student.id = st.user_id
        JOIN teachers t ON t.id = e.teacher_id
        WHERE t.user_id = ?`;
      params = [req.user.id];
    } else {
      return res.status(403).json({ error: 'Invalid role for this endpoint.' });
    }

    if (status && ['active', 'paused', 'completed'].includes(status)) {
      query += ' AND c.status = ?';
      params.push(status);
    }

    if (enrollment_id) {
      query += ' AND c.enrollment_id = ?';
      params.push(parseInt(enrollment_id, 10));
    }

    query += ' ORDER BY c.created_at DESC';

    const [rows] = await db.query(query, params);
    res.json(rows);
  } catch (err) {
    console.error('Get courses error:', err);
    res.status(500).json({ error: 'Could not fetch courses.' });
  }
});

// ---------- GET SINGLE COURSE ----------
// GET /api/courses/:id
router.get('/:id', verifyToken, async (req, res) => {
  try {
    const course = await verifyCourseParticipant(req.params.id, req.user.id, req.user.role);
    if (!course) {
      return res.status(404).json({ error: 'Course not found or access denied.' });
    }

    // Full enriched query
    const [enriched] = await db.query(
      `SELECT c.*,
              e.subject AS enrollment_subject, e.status AS enrollment_status, e.id AS enrollment_id,
              u_student.name AS student_name, u_student.profile_photo AS student_photo,
              u_teacher.name AS teacher_name, u_teacher.profile_photo AS teacher_photo,
              t.subjects AS teacher_subjects, t.qualification, t.fee_per_hour,
              st.preferred_grade AS student_grade
       FROM courses c
       JOIN enrollments e ON e.id = c.enrollment_id
       JOIN students st ON st.id = e.student_id
       JOIN users u_student ON u_student.id = st.user_id
       JOIN teachers t ON t.id = e.teacher_id
       JOIN users u_teacher ON u_teacher.id = t.user_id
       WHERE c.id = ?`,
      [req.params.id]
    );

    if (enriched.length === 0) {
      return res.status(404).json({ error: 'Course not found.' });
    }

    // Get modules
    const [modules] = await db.query(
      'SELECT * FROM course_modules WHERE course_id = ? ORDER BY sort_order ASC, id ASC',
      [req.params.id]
    );

    res.json({ ...enriched[0], modules });
  } catch (err) {
    console.error('Get course error:', err);
    res.status(500).json({ error: 'Could not fetch course.' });
  }
});

// ---------- CREATE COURSE ----------
// POST /api/courses
// body: { enrollment_id, title, description, subject, start_date, end_date }
router.post('/', verifyToken, requireRole('teacher'), async (req, res) => {
  try {
    const { enrollment_id, start_date, end_date } = req.body || {};
    const title = typeof req.body?.title === 'string' ? req.body.title : '';

    if (!enrollment_id || !title.trim()) {
      return res.status(400).json({ error: 'enrollment_id and title are required.' });
    }
    const description = optionalText(req.body.description, 5000, 'Description');
    const subject = optionalText(req.body.subject, 255, 'Subject');
    validateTextAndDates({ title, start_date, end_date });

    // Verify teacher owns this enrollment
    const enrollment = await verifyEnrollmentParticipant(enrollment_id, req.user.id, 'teacher');
    if (!enrollment) {
      return res.status(403).json({ error: 'You can only create courses for your own enrollments.' });
    }

    if (enrollment.status !== 'active') {
      return res.status(400).json({ error: 'Can only create courses for active enrollments.' });
    }

    const [result] = await db.query(
      `INSERT INTO courses (enrollment_id, title, description, subject, start_date, end_date)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [enrollment_id, title.trim(), description, subject || enrollment.subject || null,
       start_date || null, end_date || null]
    );

    // Notify the student
    const { createNotification } = require('./notification.routes');
    const [studentUser] = await db.query(
      'SELECT s.user_id FROM students s WHERE s.id = ?',
      [enrollment.student_id]
    );
    if (studentUser.length > 0) {
      await createNotification(
        studentUser[0].user_id,
        `A new course "${title.trim()}" has been created for you.`,
        'student-dashboard.html'
      );
    }

    res.status(201).json({
      message: 'Course created successfully.',
      course_id: result.insertId,
    });
  } catch (err) {
    console.error('Create course error:', err);
    if (sendValidationError(res, err)) return;
    res.status(500).json({ error: 'Could not create course.' });
  }
});

// ---------- UPDATE COURSE ----------
// PUT /api/courses/:id
// body: { title, description, subject, status, start_date, end_date }
router.put('/:id', verifyToken, requireRole('teacher'), async (req, res) => {
  try {
    const isOwner = await verifyCourseTeacher(req.params.id, req.user.id);
    if (!isOwner) {
      return res.status(403).json({ error: 'You can only update your own courses.' });
    }

    const { title, description, subject, status, start_date, end_date } = req.body || {};
    validateTextAndDates({ title, start_date, end_date });

    const updates = [];
    const params = [];

    if (title !== undefined) { updates.push('title = ?'); params.push(title.trim()); }
    if (description !== undefined) { updates.push('description = ?'); params.push(optionalText(description, 5000, 'Description')); }
    if (subject !== undefined) { updates.push('subject = ?'); params.push(optionalText(subject, 255, 'Subject')); }
    if (start_date !== undefined) { updates.push('start_date = ?'); params.push(start_date || null); }
    if (end_date !== undefined) { updates.push('end_date = ?'); params.push(end_date || null); }
    if (status && ['active', 'paused', 'completed'].includes(status)) {
      updates.push('status = ?'); params.push(status);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update.' });
    }

    params.push(req.params.id);
    await db.query(`UPDATE courses SET ${updates.join(', ')} WHERE id = ?`, params);

    res.json({ message: 'Course updated successfully.' });
  } catch (err) {
    if (sendValidationError(res, err)) return;
    console.error('Update course error:', err);
    res.status(500).json({ error: 'Could not update course.' });
  }
});

// ---------- GET COURSE MODULES ----------
// GET /api/courses/:id/modules
router.get('/:id/modules', verifyToken, async (req, res) => {
  try {
    const course = await verifyCourseParticipant(req.params.id, req.user.id, req.user.role);
    if (!course) {
      return res.status(404).json({ error: 'Course not found or access denied.' });
    }

    const [modules] = await db.query(
      'SELECT * FROM course_modules WHERE course_id = ? ORDER BY sort_order ASC, id ASC',
      [req.params.id]
    );

    res.json(modules);
  } catch (err) {
    console.error('Get modules error:', err);
    res.status(500).json({ error: 'Could not fetch modules.' });
  }
});

// ---------- CREATE MODULE ----------
// POST /api/courses/:id/modules
// body: { title, description, sort_order }
router.post('/:id/modules', verifyToken, requireRole('teacher'), async (req, res) => {
  try {
    const isOwner = await verifyCourseTeacher(req.params.id, req.user.id);
    if (!isOwner) {
      return res.status(403).json({ error: 'You can only add modules to your own courses.' });
    }

    const { title, sort_order } = req.body || {};
    if (typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({ error: 'Module title is required.' });
    }
    validateTextAndDates({ title });
    const description = optionalText(req.body.description, 5000, 'Description');

    // Auto-calculate sort order if not provided
    let order = parseInt(sort_order, 10);
    if (isNaN(order)) {
      const [[{ maxOrder }]] = await db.query(
        'SELECT COALESCE(MAX(sort_order), 0) AS maxOrder FROM course_modules WHERE course_id = ?',
        [req.params.id]
      );
      order = maxOrder + 1;
    }

    const [result] = await db.query(
      'INSERT INTO course_modules (course_id, title, description, sort_order) VALUES (?, ?, ?, ?)',
      [req.params.id, title.trim(), description, order]
    );

    res.status(201).json({
      message: 'Module created.',
      module_id: result.insertId,
    });
  } catch (err) {
    if (sendValidationError(res, err)) return;
    console.error('Create module error:', err);
    res.status(500).json({ error: 'Could not create module.' });
  }
});

// ---------- UPDATE MODULE ----------
// PUT /api/courses/:courseId/modules/:moduleId
router.put('/:courseId/modules/:moduleId', verifyToken, requireRole('teacher'), async (req, res) => {
  try {
    const isOwner = await verifyCourseTeacher(req.params.courseId, req.user.id);
    if (!isOwner) {
      return res.status(403).json({ error: 'You can only update modules in your own courses.' });
    }

    const { title, description, sort_order, status } = req.body || {};
    validateTextAndDates({ title });
    const updates = [];
    const params = [];

    if (title !== undefined) { updates.push('title = ?'); params.push(title.trim()); }
    if (description !== undefined) { updates.push('description = ?'); params.push(optionalText(description, 5000, 'Description')); }
    if (sort_order !== undefined) { updates.push('sort_order = ?'); params.push(parseInt(sort_order, 10) || 0); }
    if (status && ['active', 'completed'].includes(status)) { updates.push('status = ?'); params.push(status); }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update.' });
    }

    params.push(req.params.moduleId, req.params.courseId);
    await db.query(`UPDATE course_modules SET ${updates.join(', ')} WHERE id = ? AND course_id = ?`, params);

    res.json({ message: 'Module updated.' });
  } catch (err) {
    if (sendValidationError(res, err)) return;
    console.error('Update module error:', err);
    res.status(500).json({ error: 'Could not update module.' });
  }
});

// ---------- DELETE MODULE ----------
// DELETE /api/courses/:courseId/modules/:moduleId
router.delete('/:courseId/modules/:moduleId', verifyToken, requireRole('teacher'), async (req, res) => {
  try {
    const isOwner = await verifyCourseTeacher(req.params.courseId, req.user.id);
    if (!isOwner) {
      return res.status(403).json({ error: 'You can only delete modules from your own courses.' });
    }

    await db.query(
      'DELETE FROM course_modules WHERE id = ? AND course_id = ?',
      [req.params.moduleId, req.params.courseId]
    );

    res.json({ message: 'Module deleted.' });
  } catch (err) {
    console.error('Delete module error:', err);
    res.status(500).json({ error: 'Could not delete module.' });
  }
});

module.exports = router;
module.exports.verifyCourseParticipant = verifyCourseParticipant;
module.exports.verifyCourseTeacher = verifyCourseTeacher;
