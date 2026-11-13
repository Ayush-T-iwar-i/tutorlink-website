/**
 * The student's side of a monthly tuition ("My tuition").
 *
 * Mounted at /api/my-tuition. Every route needs a logged-in student and only ever touches that
 * student's own enrollments: somebody else's enrollment answers 404, exactly like a missing one.
 *
 * What a student can see: the teacher, the schedule, attendance, what was taught / is planned, test
 * marks and homework (only published homework). What a student can NOT see: the teacher's private
 * notes, the teacher's per-class notes, and the teacher's offline fee records.
 *
 *   GET  /                                  the student's monthly tuitions with a short summary each
 *   GET  /:id                               one tuition in full
 *   GET  /:id/sessions                      classes: date, time, status, attendance, topic
 *   GET  /:id/tests                         tests and marks
 *   GET  /:id/assignments                   published homework with the student's own submission
 *   POST /:id/assignments/:assignmentId/submit    hand in (or re-submit) an answer until it is checked
 */
const express = require('express');
const router = express.Router();
const db = require('../config/db');
const rules = require('../lib/booking-rules');
const { verifyToken, requireRole } = require('../middleware/auth.middleware');
const { createNotification } = require('./notification.routes');

router.use(verifyToken, requireRole('student'));

class TuitionError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function sendError(res, err, fallback, label) {
  if (err instanceof TuitionError) return res.status(err.status).json({ error: err.message, code: err.code });
  console.error(label, err);
  if (res.headersSent) return undefined;
  return res.status(500).json({ error: fallback, code: 'INTERNAL_ERROR' });
}

function id(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Returns the enrollment if it belongs to this student, else throws 404.
async function ownedEnrollment(req) {
  const enrollmentId = id(req.params.id);
  if (!enrollmentId) throw new TuitionError(404, 'Tuition not found.', 'NOT_FOUND');
  const [rows] = await db.query(
    `SELECT e.id, e.student_id, e.teacher_id, e.booking_id, e.subject, e.status, e.start_date, e.end_date,
            b.type AS booking_type, b.days_per_week, b.booking_time, b.fee AS monthly_fee
     FROM enrollments e
     JOIN students st ON st.id = e.student_id
     LEFT JOIN bookings b ON b.id = e.booking_id
     WHERE e.id = ? AND st.user_id = ? AND e.status <> 'cancelled' AND (b.id IS NULL OR b.type = 'recurring')`,
    [enrollmentId, req.user.id]
  );
  if (rows.length === 0) throw new TuitionError(404, 'Tuition not found.', 'NOT_FOUND');
  return rows[0];
}

const num = (v) => (v === null || v === undefined ? null : Number(v));

// =====================================================================
// LIST
// =====================================================================
router.get('/', async (req, res) => {
  try {
    const today = rules.todayInTz();
    const [rows] = await db.query(
      `SELECT e.id, e.subject, e.status, e.start_date, e.booking_id,
              tu.name AS teacher_name, tu.profile_photo AS teacher_photo,
              b.days_per_week, b.booking_time,
              (SELECT COUNT(*) FROM class_sessions cs WHERE cs.booking_id = e.booking_id AND cs.attendance IN ('present','late')) AS classes_attended,
              (SELECT COUNT(*) FROM class_sessions cs WHERE cs.booking_id = e.booking_id AND cs.attendance = 'absent') AS classes_absent,
              (SELECT MIN(cs.session_date) FROM class_sessions cs WHERE cs.booking_id = e.booking_id AND cs.status = 'scheduled' AND cs.session_date >= ?) AS next_class_date,
              (SELECT COUNT(*) FROM assignments a JOIN courses c ON c.id = a.course_id
                 LEFT JOIN assignment_submissions sub ON sub.assignment_id = a.id AND sub.student_id = e.student_id
                 WHERE c.enrollment_id = e.id AND a.status = 'published' AND sub.id IS NULL) AS homework_to_do,
              (SELECT AVG(tt.marks_obtained * 100.0 / tt.max_marks) FROM student_tests tt WHERE tt.enrollment_id = e.id AND tt.marks_obtained IS NOT NULL) AS avg_test_percent
       FROM enrollments e
       JOIN students st ON st.id = e.student_id
       JOIN teachers t ON t.id = e.teacher_id
       JOIN users tu ON tu.id = t.user_id
       LEFT JOIN bookings b ON b.id = e.booking_id
       WHERE st.user_id = ? AND e.status <> 'cancelled' AND (b.id IS NULL OR b.type = 'recurring')
       ORDER BY e.id DESC`,
      [today, req.user.id]
    );

    const tuitions = [];
    for (const r of rows) {
      let nextTime = null;
      if (r.next_class_date) {
        const [t] = await db.query(
          `SELECT session_time FROM class_sessions
           WHERE booking_id = ? AND status = 'scheduled' AND session_date = ? ORDER BY id ASC LIMIT 1`,
          [r.booking_id, r.next_class_date]
        );
        nextTime = t[0] ? t[0].session_time : null;
      }
      tuitions.push({
        ...r,
        classes_attended: Number(r.classes_attended) || 0,
        classes_absent: Number(r.classes_absent) || 0,
        homework_to_do: Number(r.homework_to_do) || 0,
        avg_test_percent: r.avg_test_percent === null ? null : Math.round(Number(r.avg_test_percent) * 10) / 10,
        next_class_time: nextTime,
      });
    }
    res.json({ today, tuitions });
  } catch (err) {
    sendError(res, err, 'Could not load your tuition.', 'List my tuition error:');
  }
});

// =====================================================================
// ONE TUITION
// =====================================================================
router.get('/:id', async (req, res) => {
  try {
    const e = await ownedEnrollment(req);
    const today = rules.todayInTz();

    const [teacher] = await db.query(
      `SELECT t.id AS teacher_id, tu.name, tu.profile_photo, t.qualification, t.experience_years
       FROM teachers t JOIN users tu ON tu.id = t.user_id WHERE t.id = ?`,
      [e.teacher_id]
    );

    const attendance = { present: 0, late: 0, absent: 0, excused: 0, upcoming: 0 };
    if (e.booking_id) {
      const [rows] = await db.query('SELECT attendance, status, session_date FROM class_sessions WHERE booking_id = ?', [e.booking_id]);
      rows.forEach((s) => {
        if (s.attendance) attendance[s.attendance] += 1;
        else if (s.status === 'scheduled' && s.session_date >= today) attendance.upcoming += 1;
      });
    }

    const [courses] = await db.query(
      `SELECT c.id, c.title,
              (SELECT COUNT(*) FROM course_modules m WHERE m.course_id = c.id) AS module_count,
              (SELECT COUNT(*) FROM course_modules m WHERE m.course_id = c.id AND m.status = 'completed') AS modules_done
       FROM courses c WHERE c.enrollment_id = ? ORDER BY c.id ASC`,
      [e.id]
    );

    const [tests] = await db.query(
      `SELECT COUNT(*) AS n, AVG(marks_obtained * 100.0 / max_marks) AS avg_percent
       FROM student_tests WHERE enrollment_id = ? AND marks_obtained IS NOT NULL`,
      [e.id]
    );

    res.json({
      id: e.id,
      subject: e.subject,
      status: e.status,
      start_date: e.start_date,
      end_date: e.end_date,
      booking_id: e.booking_id,
      schedule: { days: e.days_per_week || null, time: e.booking_time || null },
      monthly_fee: num(e.monthly_fee),
      teacher: teacher[0] || null,
      attendance,
      courses: courses.map((c) => ({ ...c, module_count: Number(c.module_count), modules_done: Number(c.modules_done) })),
      tests: {
        marked: Number(tests[0].n) || 0,
        avg_percent: tests[0].avg_percent === null ? null : Math.round(Number(tests[0].avg_percent) * 10) / 10,
      },
      today,
    });
  } catch (err) {
    sendError(res, err, 'Could not load this tuition.', 'Get my tuition error:');
  }
});

router.get('/:id/sessions', async (req, res) => {
  try {
    const e = await ownedEnrollment(req);
    if (!e.booking_id) return res.json([]);
    // The teacher's per-class notes stay private; the student only sees the topic.
    const [rows] = await db.query(
      `SELECT id, session_date, session_time, status, attendance, topic
       FROM class_sessions WHERE booking_id = ? ORDER BY session_date ASC, id ASC LIMIT 1000`,
      [e.booking_id]
    );
    res.json(rows);
  } catch (err) {
    sendError(res, err, 'Could not load classes.', 'Get my tuition sessions error:');
  }
});

router.get('/:id/tests', async (req, res) => {
  try {
    const e = await ownedEnrollment(req);
    const [rows] = await db.query(
      `SELECT id, title, test_date, max_marks, marks_obtained, remarks FROM student_tests
       WHERE enrollment_id = ? ORDER BY test_date DESC, id DESC`,
      [e.id]
    );
    res.json(rows.map((r) => ({ ...r, max_marks: Number(r.max_marks), marks_obtained: num(r.marks_obtained) })));
  } catch (err) {
    sendError(res, err, 'Could not load tests.', 'Get my tuition tests error:');
  }
});

// =====================================================================
// HOMEWORK
// =====================================================================
router.get('/:id/assignments', async (req, res) => {
  try {
    const e = await ownedEnrollment(req);
    const [rows] = await db.query(
      `SELECT a.id, a.title, a.instructions, a.due_date, c.title AS course_title,
              sub.status AS submission_status, sub.submission_text, sub.feedback, sub.submitted_at, sub.reviewed_at
       FROM assignments a
       JOIN courses c ON c.id = a.course_id
       LEFT JOIN assignment_submissions sub ON sub.assignment_id = a.id AND sub.student_id = ?
       WHERE c.enrollment_id = ? AND a.status = 'published'
       ORDER BY a.due_date IS NULL, a.due_date DESC, a.id DESC`,
      [e.student_id, e.id]
    );
    res.json(rows);
  } catch (err) {
    sendError(res, err, 'Could not load homework.', 'Get my tuition assignments error:');
  }
});

router.post('/:id/assignments/:assignmentId/submit', async (req, res) => {
  try {
    const e = await ownedEnrollment(req);
    const aid = id(req.params.assignmentId);
    if (!aid) throw new TuitionError(404, 'Homework not found.', 'NOT_FOUND');
    if (e.status !== 'active') throw new TuitionError(400, 'Homework can only be handed in while the tuition is active.', 'NOT_ACTIVE');

    const raw = (req.body || {}).text;
    if (typeof raw !== 'string' || !raw.trim()) throw new TuitionError(400, 'Please write your answer first.', 'VALIDATION');
    const text = raw.trim();
    if (text.length > 3000) throw new TuitionError(400, 'Your answer must be at most 3000 characters.', 'VALIDATION');

    const [rows] = await db.query(
      `SELECT a.id, a.title FROM assignments a JOIN courses c ON c.id = a.course_id
       WHERE a.id = ? AND c.enrollment_id = ? AND a.status = 'published'`,
      [aid, e.id]
    );
    if (rows.length === 0) throw new TuitionError(404, 'Homework not found.', 'NOT_FOUND');

    const [existing] = await db.query(
      'SELECT id, status FROM assignment_submissions WHERE assignment_id = ? AND student_id = ?',
      [aid, e.student_id]
    );
    if (existing.length > 0) {
      if (existing[0].status === 'reviewed') {
        throw new TuitionError(409, 'Your teacher has already checked this homework.', 'ALREADY_REVIEWED');
      }
      await db.query(
        "UPDATE assignment_submissions SET submission_text = ?, status = 'submitted', submitted_at = NOW() WHERE id = ?",
        [text, existing[0].id]
      );
    } else {
      await db.query(
        "INSERT INTO assignment_submissions (assignment_id, student_id, submission_text, status) VALUES (?, ?, ?, 'submitted')",
        [aid, e.student_id, text]
      );
    }

    try {
      const [t] = await db.query('SELECT user_id FROM teachers WHERE id = ?', [e.teacher_id]);
      if (t.length > 0) {
        await createNotification(t[0].user_id, `A student handed in homework: ${rows[0].title}.`, `teacher-students.html?id=${e.id}&tab=homework`);
      }
    } catch (notifyErr) {
      console.error('Notify teacher error:', notifyErr);
    }
    res.json({ message: existing.length > 0 ? 'Your answer was updated.' : 'Homework handed in.' });
  } catch (err) {
    sendError(res, err, 'Could not hand in the homework.', 'Submit my tuition homework error:');
  }
});

module.exports = router;