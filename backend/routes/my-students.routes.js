/**
 * Teacher tools for the students they teach every month ("My students").
 *
 * Mounted at /api/my-students. Every route needs a logged-in teacher and only ever touches
 * enrollments that belong to that teacher: a request for somebody else's enrollment answers 404,
 * exactly like a request for an enrollment that does not exist, so ids cannot be probed.
 *
 *   GET    /                              list of students with a short summary each
 *   GET    /:id                           one student's full profile + summaries
 *   GET    /:id/sessions                  every class: date, time, status, attendance, topic, notes
 *   POST   /:id/sessions                  add one extra class
 *   POST   /:id/sessions/extend           schedule the next weeks of the weekly timetable
 *   PUT    /:id/sessions/:sessionId       attendance / topic / notes / cancel
 *   GET    /:id/fees                      monthly fee records + online payments
 *   POST   /:id/fees                      create or update one month's fee record
 *   DELETE /:id/fees/:feeId
 *   GET    /:id/tests    POST /:id/tests    PUT|DELETE /:id/tests/:testId
 *   GET    /:id/notes    POST /:id/notes    DELETE /:id/notes/:noteId
 *   GET    /:id/assignments    POST /:id/assignments    PUT /:id/assignments/:assignmentId/review
 *   DELETE /:id/assignments/:assignmentId
 *
 * Pausing / ending a tuition keeps using PUT /api/enrollments/:id/status.
 */
const express = require('express');
const router = express.Router();
const db = require('../config/db');
const rules = require('../lib/booking-rules');
const { withTransaction } = require('../lib/tx');
const { verifyToken, requireRole } = require('../middleware/auth.middleware');
const { createNotification } = require('./notification.routes');

router.use(verifyToken, requireRole('teacher'));

class StudentError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function sendError(res, err, fallback, label) {
  if (err instanceof StudentError) return res.status(err.status).json({ error: err.message, code: err.code });
  console.error(label, err);
  if (res.headersSent) return undefined;
  return res.status(500).json({ error: fallback, code: 'INTERNAL_ERROR' });
}

// ---------- small validators ----------
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const ATTENDANCE = ['present', 'late', 'absent', 'excused'];
const FEE_METHODS = ['cash', 'upi', 'bank', 'online', 'other'];

const bad = (message, code = 'VALIDATION') => new StudentError(400, message, code);

function text(value, max, label, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw bad(`${label} is required.`);
    return null;
  }
  if (typeof value !== 'string') throw bad(`${label} must be text.`);
  const t = value.trim();
  if (!t) {
    if (required) throw bad(`${label} is required.`);
    return null;
  }
  if (t.length > max) throw bad(`${label} must be at most ${max} characters.`);
  return t;
}

function number(value, label, { min = 0, max, required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw bad(`${label} is required.`);
    return null;
  }
  const n = typeof value === 'number' ? value : (typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN);
  if (!Number.isFinite(n)) throw bad(`${label} must be a number.`);
  if (n < min) throw bad(`${label} cannot be less than ${min}.`);
  if (max !== undefined && n > max) throw bad(`${label} cannot be more than ${max}.`);
  return Math.round(n * 100) / 100;
}

function date(value, label, { required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw bad(`${label} is required.`);
    return null;
  }
  if (!rules.isValidDateString(value)) throw bad(`${label} must be a valid date (YYYY-MM-DD).`);
  return value;
}

function id(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// ---------- ownership ----------
// Returns the enrollment (with its booking's schedule) if it belongs to this teacher, else throws 404.
async function ownedEnrollment(req) {
  const enrollmentId = id(req.params.id);
  if (!enrollmentId) throw new StudentError(404, 'Student not found.', 'NOT_FOUND');
  const [rows] = await db.query(
    `SELECT e.id, e.student_id, e.teacher_id, e.booking_id, e.subject, e.status, e.start_date, e.end_date, e.notes,
            b.type AS booking_type, b.days_per_week, b.booking_time, b.fee AS monthly_fee, b.payment_status
     FROM enrollments e
     JOIN teachers t ON t.id = e.teacher_id
     LEFT JOIN bookings b ON b.id = e.booking_id
     WHERE e.id = ? AND t.user_id = ?`,
    [enrollmentId, req.user.id]
  );
  if (rows.length === 0) throw new StudentError(404, 'Student not found.', 'NOT_FOUND');
  return rows[0];
}

const money = (v) => (v === null || v === undefined ? null : Number(v));

// =====================================================================
// LIST
// =====================================================================
router.get('/', async (req, res) => {
  try {
    const today = rules.todayInTz();
    const month = today.slice(0, 7);
    const [rows] = await db.query(
      `SELECT e.id, e.subject, e.status, e.start_date, e.end_date, e.booking_id,
              su.name AS student_name, su.profile_photo AS student_photo,
              st.preferred_grade AS student_grade, st.city AS student_city,
              b.days_per_week, b.booking_time, b.fee AS monthly_fee,
              (SELECT COUNT(*) FROM class_sessions cs WHERE cs.booking_id = e.booking_id AND cs.attendance IN ('present','late')) AS classes_attended,
              (SELECT COUNT(*) FROM class_sessions cs WHERE cs.booking_id = e.booking_id AND cs.attendance = 'absent') AS classes_absent,
              (SELECT COUNT(*) FROM class_sessions cs WHERE cs.booking_id = e.booking_id AND cs.status = 'scheduled' AND cs.session_date < ?) AS unmarked_classes,
              (SELECT MIN(cs.session_date) FROM class_sessions cs WHERE cs.booking_id = e.booking_id AND cs.status = 'scheduled' AND cs.session_date >= ?) AS next_class_date,
              (SELECT fr.status FROM fee_records fr WHERE fr.enrollment_id = e.id AND fr.period_month = ?) AS fee_this_month,
              (SELECT MAX(fr.paid_on) FROM fee_records fr WHERE fr.enrollment_id = e.id AND fr.status = 'paid') AS last_paid_on,
              (SELECT COUNT(*) FROM fee_records fr WHERE fr.enrollment_id = e.id AND fr.status = 'due') AS fees_due_count,
              (SELECT AVG(tt.marks_obtained * 100.0 / tt.max_marks) FROM student_tests tt WHERE tt.enrollment_id = e.id AND tt.marks_obtained IS NOT NULL) AS avg_test_percent
       FROM enrollments e
       JOIN teachers t ON t.id = e.teacher_id
       JOIN students st ON st.id = e.student_id
       JOIN users su ON su.id = st.user_id
       LEFT JOIN bookings b ON b.id = e.booking_id
       WHERE t.user_id = ? AND e.status <> 'cancelled' AND (b.id IS NULL OR b.type = 'recurring')
       ORDER BY e.id DESC`,
      [today, today, month, req.user.id]
    );

    // Next class time: one small lookup per student keeps the big query readable.
    const students = [];
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
      students.push({
        ...r,
        monthly_fee: money(r.monthly_fee),
        classes_attended: Number(r.classes_attended) || 0,
        classes_absent: Number(r.classes_absent) || 0,
        unmarked_classes: Number(r.unmarked_classes) || 0,
        fees_due_count: Number(r.fees_due_count) || 0,
        avg_test_percent: r.avg_test_percent === null ? null : Math.round(Number(r.avg_test_percent) * 10) / 10,
        next_class_time: nextTime,
      });
    }
    res.json({ today, month, students });
  } catch (err) {
    sendError(res, err, 'Could not load your students.', 'List my students error:');
  }
});

// =====================================================================
// ONE STUDENT
// =====================================================================
router.get('/:id', async (req, res) => {
  try {
    const e = await ownedEnrollment(req);
    const today = rules.todayInTz();

    const [people] = await db.query(
      `SELECT su.id AS user_id, su.name, su.email, su.phone, su.profile_photo,
              st.preferred_grade, st.preferred_subjects, st.address, st.area, st.district, st.city, st.pincode
       FROM students st JOIN users su ON su.id = st.user_id WHERE st.id = ?`,
      [e.student_id]
    );

    let attendance = { present: 0, late: 0, absent: 0, excused: 0, upcoming: 0, unmarked: 0 };
    if (e.booking_id) {
      const [rows] = await db.query(
        `SELECT attendance, status, session_date FROM class_sessions WHERE booking_id = ?`,
        [e.booking_id]
      );
      rows.forEach((s) => {
        if (s.attendance) attendance[s.attendance] += 1;
        else if (s.status === 'scheduled') {
          if (s.session_date < today) attendance.unmarked += 1;
          else attendance.upcoming += 1;
        }
      });
    }

    const [courses] = await db.query(
      `SELECT c.id, c.title, c.subject, c.status, c.start_date,
              (SELECT COUNT(*) FROM course_modules m WHERE m.course_id = c.id) AS module_count,
              (SELECT COUNT(*) FROM course_modules m WHERE m.course_id = c.id AND m.status = 'completed') AS modules_done
       FROM courses c WHERE c.enrollment_id = ? ORDER BY c.id ASC`,
      [e.id]
    );

    const [feeRows] = await db.query(
      `SELECT status, COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total FROM fee_records WHERE enrollment_id = ? GROUP BY status`,
      [e.id]
    );
    const fees = { paid_count: 0, paid_total: 0, due_count: 0, due_total: 0 };
    feeRows.forEach((r) => {
      if (r.status === 'paid') { fees.paid_count = Number(r.n); fees.paid_total = Number(r.total); }
      if (r.status === 'due') { fees.due_count = Number(r.n); fees.due_total = Number(r.total); }
    });

    const [testRows] = await db.query(
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
      schedule: { days: e.days_per_week || null, time: e.booking_time || null, type: e.booking_type || null },
      monthly_fee: money(e.monthly_fee),
      student: people[0] || null,
      attendance,
      courses: courses.map((c) => ({ ...c, module_count: Number(c.module_count), modules_done: Number(c.modules_done) })),
      fees,
      tests: {
        marked: Number(testRows[0].n) || 0,
        avg_percent: testRows[0].avg_percent === null ? null : Math.round(Number(testRows[0].avg_percent) * 10) / 10,
      },
      today,
    });
  } catch (err) {
    sendError(res, err, 'Could not load this student.', 'Get my student error:');
  }
});

// =====================================================================
// CLASSES (sessions, attendance, what was taught / will be taught)
// =====================================================================
router.get('/:id/sessions', async (req, res) => {
  try {
    const e = await ownedEnrollment(req);
    if (!e.booking_id) return res.json([]);
    const [rows] = await db.query(
      `SELECT id, session_date, session_time, status, attendance, topic, notes
       FROM class_sessions WHERE booking_id = ? ORDER BY session_date ASC, id ASC LIMIT 1000`,
      [e.booking_id]
    );
    res.json(rows);
  } catch (err) {
    sendError(res, err, 'Could not load classes.', 'Get my student sessions error:');
  }
});

// The teacher must not be double-booked: another of their classes at the same date and time blocks it.
async function takenSlots(teacherId, fromDate, toDate, time, excludeBookingId) {
  const [rows] = await db.query(
    `SELECT cs.session_date FROM class_sessions cs
     JOIN bookings b ON b.id = cs.booking_id
     WHERE b.teacher_id = ? AND cs.session_time = ? AND cs.session_date BETWEEN ? AND ?
       AND cs.status IN ('scheduled','completed') AND cs.booking_id <> ?`,
    [teacherId, time, fromDate, toDate, excludeBookingId]
  );
  return new Set(rows.map((r) => String(r.session_date).slice(0, 10)));
}

router.post('/:id/sessions', async (req, res) => {
  try {
    const e = await ownedEnrollment(req);
    if (!e.booking_id) throw bad('This student has no class schedule to add to.', 'NO_BOOKING');
    if (e.status !== 'active') throw bad('Classes can only be added while the tuition is active.', 'NOT_ACTIVE');

    const sessionDate = date(req.body.session_date, 'Date');
    const time = rules.normalizeSlot(req.body.session_time);
    if (!time) throw bad('Please choose a valid time, for example 5:00 PM.');
    const topic = text(req.body.topic, 255, 'Topic');
    const today = rules.todayInTz();
    if (sessionDate < today) throw bad('A class cannot be added in the past.', 'PAST_DATE');
    if (rules.isInPast(sessionDate, time)) throw bad('That time has already passed today.', 'PAST_DATE');
    if (rules.isTooFarAhead(sessionDate)) throw bad(`Classes can be scheduled at most ${rules.MAX_BOOKING_DAYS_AHEAD} days ahead.`, 'TOO_FAR');

    const taken = await takenSlots(e.teacher_id, sessionDate, sessionDate, time, e.booking_id);
    if (taken.has(sessionDate)) throw new StudentError(409, 'You already have another class at that date and time.', 'SLOT_TAKEN');

    const [dup] = await db.query(
      `SELECT id FROM class_sessions WHERE booking_id = ? AND session_date = ? AND session_time = ?`,
      [e.booking_id, sessionDate, time]
    );
    if (dup.length > 0) throw new StudentError(409, 'This student already has a class at that date and time.', 'DUPLICATE');

    const [r] = await db.query(
      `INSERT INTO class_sessions (booking_id, session_date, session_time, topic) VALUES (?, ?, ?, ?)`,
      [e.booking_id, sessionDate, time, topic]
    );
    res.status(201).json({ id: r.insertId, message: 'Class added.' });
  } catch (err) {
    sendError(res, err, 'Could not add the class.', 'Add my student session error:');
  }
});

router.post('/:id/sessions/extend', async (req, res) => {
  try {
    const e = await ownedEnrollment(req);
    if (!e.booking_id || e.booking_type !== 'recurring') throw bad('Only a weekly timetable can be extended.', 'NOT_RECURRING');
    if (e.status !== 'active') throw bad('The timetable can only be extended while the tuition is active.', 'NOT_ACTIVE');
    const days = rules.parseDays(e.days_per_week);
    const time = rules.normalizeSlot(e.booking_time);
    if (!days || !time) throw bad('This student has no weekly days or time on record.', 'NO_SCHEDULE');

    const weeks = req.body.weeks === undefined ? 4 : Number(req.body.weeks);
    if (!Number.isInteger(weeks) || weeks < 1 || weeks > 8) throw bad('Weeks must be a whole number from 1 to 8.');

    const today = rules.todayInTz();
    const [last] = await db.query(
      `SELECT MAX(session_date) AS last_date FROM class_sessions WHERE booking_id = ? AND status <> 'cancelled'`,
      [e.booking_id]
    );
    const lastDate = last[0] && last[0].last_date ? String(last[0].last_date).slice(0, 10) : null;
    const start = lastDate && rules.addDays(lastDate, 1) > today ? rules.addDays(lastDate, 1) : today;

    const candidates = rules.occurrenceDates({ type: 'recurring', booking_date: start, days_per_week: e.days_per_week }, weeks)
      .filter((d) => !rules.isTooFarAhead(d))
      .filter((d) => !rules.isInPast(d, time));
    if (candidates.length === 0) throw bad('No new class dates fall inside the allowed booking window.', 'NOTHING_TO_ADD');

    const taken = await takenSlots(e.teacher_id, candidates[0], candidates[candidates.length - 1], time, e.booking_id);
    const free = candidates.filter((d) => !taken.has(d));
    const skipped = candidates.filter((d) => taken.has(d));

    let added = 0;
    if (free.length > 0) {
      await withTransaction(db, async (conn) => {
        const [r] = await conn.query(
          'INSERT IGNORE INTO class_sessions (booking_id, session_date, session_time) VALUES ?',
          [free.map((d) => [e.booking_id, d, time])]
        );
        added = r.affectedRows;
      });
    }
    res.json({ added, skipped, message: added === 1 ? '1 class scheduled.' : `${added} classes scheduled.` });
  } catch (err) {
    sendError(res, err, 'Could not extend the timetable.', 'Extend my student timetable error:');
  }
});

router.put('/:id/sessions/:sessionId', async (req, res) => {
  try {
    const e = await ownedEnrollment(req);
    const sessionId = id(req.params.sessionId);
    if (!e.booking_id || !sessionId) throw new StudentError(404, 'Class not found.', 'NOT_FOUND');
    const [rows] = await db.query(
      `SELECT id, session_date, status, attendance FROM class_sessions WHERE id = ? AND booking_id = ?`,
      [sessionId, e.booking_id]
    );
    if (rows.length === 0) throw new StudentError(404, 'Class not found.', 'NOT_FOUND');
    const s = rows[0];
    const sessionDate = String(s.session_date).slice(0, 10);
    const body = req.body || {};

    const sets = [];
    const params = [];

    if (body.topic !== undefined) { sets.push('topic = ?'); params.push(text(body.topic, 255, 'Topic')); }
    if (body.notes !== undefined) { sets.push('notes = ?'); params.push(text(body.notes, 2000, 'Notes')); }

    if (body.attendance !== undefined) {
      if (s.status === 'cancelled') throw bad('A cancelled class cannot have attendance.', 'CANCELLED');
      if (body.attendance === null || body.attendance === '') {
        sets.push('attendance = NULL', "status = 'scheduled'");
      } else {
        if (!ATTENDANCE.includes(body.attendance)) throw bad(`Attendance must be one of: ${ATTENDANCE.join(', ')}.`);
        if (sessionDate > rules.todayInTz()) throw bad('Attendance can only be recorded for a class that has started.', 'NOT_STARTED');
        sets.push('attendance = ?', 'status = ?');
        params.push(body.attendance, body.attendance === 'present' || body.attendance === 'late' ? 'completed' : 'missed');
      }
    }

    if (body.status !== undefined) {
      if (body.status !== 'cancelled') throw bad('The only status change allowed here is cancelling a class.');
      if (s.status !== 'scheduled' || s.attendance) throw bad('Only a class that has not been taken can be cancelled.', 'NOT_CANCELLABLE');
      if (body.attendance !== undefined) throw bad('Send either attendance or a cancellation, not both.');
      sets.push("status = 'cancelled'");
    }

    if (sets.length === 0) throw bad('Nothing to update.');
    params.push(sessionId);
    await db.query(`UPDATE class_sessions SET ${sets.join(', ')} WHERE id = ?`, params);
    res.json({ message: 'Class updated.' });
  } catch (err) {
    sendError(res, err, 'Could not update the class.', 'Update my student session error:');
  }
});

// =====================================================================
// FEES (monthly)
// =====================================================================
router.get('/:id/fees', async (req, res) => {
  try {
    const e = await ownedEnrollment(req);
    const [records] = await db.query(
      `SELECT id, period_month, amount, status, paid_on, method, note
       FROM fee_records WHERE enrollment_id = ? ORDER BY period_month DESC`,
      [e.id]
    );
    let online = [];
    if (e.booking_id) {
      const [p] = await db.query(
        `SELECT id, method, status, amount_paise, paid_at FROM payments
         WHERE booking_id = ? AND status IN ('paid','refund_pending','refunded') ORDER BY id DESC`,
        [e.booking_id]
      );
      online = p.map((x) => ({ id: x.id, method: x.method, status: x.status, amount: Number(x.amount_paise) / 100, paid_at: x.paid_at }));
    }
    res.json({
      monthly_fee: money(e.monthly_fee),
      start_date: e.start_date,
      records: records.map((r) => ({ ...r, amount: Number(r.amount) })),
      online_payments: online,
    });
  } catch (err) {
    sendError(res, err, 'Could not load fees.', 'Get my student fees error:');
  }
});

router.post('/:id/fees', async (req, res) => {
  try {
    const e = await ownedEnrollment(req);
    const body = req.body || {};
    const month = body.period_month;
    if (typeof month !== 'string' || !MONTH_RE.test(month)) throw bad('Month must look like 2026-11.');
    const today = rules.todayInTz();
    const [ty, tm] = today.split('-').map(Number);
    const [my, mm] = month.split('-').map(Number);
    if ((my * 12 + mm) - (ty * 12 + tm) > 12) throw bad('That month is too far ahead.');
    const amount = number(body.amount, 'Amount', { min: 0, max: 1000000 });
    const status = body.status === undefined ? 'paid' : body.status;
    if (status !== 'due' && status !== 'paid') throw bad('Status must be due or paid.');
    const note = text(body.note, 255, 'Note');

    let paidOn = null;
    let method = null;
    if (status === 'paid') {
      paidOn = date(body.paid_on === undefined || body.paid_on === '' ? today : body.paid_on, 'Paid on');
      if (paidOn > today) throw bad('The payment date cannot be in the future.');
      if (!FEE_METHODS.includes(body.method)) throw bad(`Please choose how it was paid: ${FEE_METHODS.join(', ')}.`);
      method = body.method;
    }

    const [existing] = await db.query('SELECT id FROM fee_records WHERE enrollment_id = ? AND period_month = ?', [e.id, month]);
    if (existing.length > 0) {
      await db.query(
        'UPDATE fee_records SET amount = ?, status = ?, paid_on = ?, method = ?, note = ? WHERE id = ?',
        [amount, status, paidOn, method, note, existing[0].id]
      );
      return res.json({ id: existing[0].id, message: 'Fee record updated.' });
    }
    const [r] = await db.query(
      'INSERT INTO fee_records (enrollment_id, period_month, amount, status, paid_on, method, note) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [e.id, month, amount, status, paidOn, method, note]
    );
    res.status(201).json({ id: r.insertId, message: 'Fee record saved.' });
  } catch (err) {
    sendError(res, err, 'Could not save the fee record.', 'Save my student fee error:');
  }
});

router.delete('/:id/fees/:feeId', async (req, res) => {
  try {
    const e = await ownedEnrollment(req);
    const feeId = id(req.params.feeId);
    const [r] = feeId ? await db.query('DELETE FROM fee_records WHERE id = ? AND enrollment_id = ?', [feeId, e.id]) : [{ affectedRows: 0 }];
    if (r.affectedRows === 0) throw new StudentError(404, 'Fee record not found.', 'NOT_FOUND');
    res.json({ message: 'Fee record deleted.' });
  } catch (err) {
    sendError(res, err, 'Could not delete the fee record.', 'Delete my student fee error:');
  }
});

// =====================================================================
// TESTS
// =====================================================================
function testFields(body, { partial }) {
  const out = {};
  const has = (k) => body[k] !== undefined;
  if (!partial || has('title')) out.title = text(body.title, 150, 'Title', { required: true });
  if (!partial || has('test_date')) out.test_date = date(body.test_date, 'Test date');
  if (!partial || has('max_marks')) out.max_marks = number(body.max_marks, 'Maximum marks', { min: 1, max: 1000 });
  if (!partial || has('marks_obtained')) out.marks_obtained = number(body.marks_obtained, 'Marks obtained', { min: 0, max: 1000, required: false });
  if (!partial || has('remarks')) out.remarks = text(body.remarks, 500, 'Remarks');
  return out;
}

router.get('/:id/tests', async (req, res) => {
  try {
    const e = await ownedEnrollment(req);
    const [rows] = await db.query(
      `SELECT id, title, test_date, max_marks, marks_obtained, remarks FROM student_tests
       WHERE enrollment_id = ? ORDER BY test_date DESC, id DESC`,
      [e.id]
    );
    res.json(rows.map((r) => ({ ...r, max_marks: Number(r.max_marks), marks_obtained: money(r.marks_obtained) })));
  } catch (err) {
    sendError(res, err, 'Could not load tests.', 'Get my student tests error:');
  }
});

router.post('/:id/tests', async (req, res) => {
  try {
    const e = await ownedEnrollment(req);
    const f = testFields(req.body || {}, { partial: false });
    if (f.marks_obtained !== null && f.marks_obtained > f.max_marks) throw bad('Marks obtained cannot be more than the maximum marks.');
    const [r] = await db.query(
      'INSERT INTO student_tests (enrollment_id, title, test_date, max_marks, marks_obtained, remarks) VALUES (?, ?, ?, ?, ?, ?)',
      [e.id, f.title, f.test_date, f.max_marks, f.marks_obtained, f.remarks]
    );
    if (f.marks_obtained !== null) await notifyStudent(e.student_id, `Your result for "${f.title}" is in: ${f.marks_obtained} / ${f.max_marks}.`);
    res.status(201).json({ id: r.insertId, message: 'Test saved.' });
  } catch (err) {
    sendError(res, err, 'Could not save the test.', 'Add my student test error:');
  }
});

router.put('/:id/tests/:testId', async (req, res) => {
  try {
    const e = await ownedEnrollment(req);
    const testId = id(req.params.testId);
    const [rows] = testId ? await db.query('SELECT id, title, max_marks, marks_obtained FROM student_tests WHERE id = ? AND enrollment_id = ?', [testId, e.id]) : [[]];
    if (rows.length === 0) throw new StudentError(404, 'Test not found.', 'NOT_FOUND');
    const f = testFields(req.body || {}, { partial: true });
    const keys = Object.keys(f);
    if (keys.length === 0) throw bad('Nothing to update.');
    const max = f.max_marks !== undefined ? f.max_marks : Number(rows[0].max_marks);
    const marks = f.marks_obtained !== undefined ? f.marks_obtained : money(rows[0].marks_obtained);
    if (marks !== null && marks > max) throw bad('Marks obtained cannot be more than the maximum marks.');
    await db.query(`UPDATE student_tests SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...keys.map((k) => f[k]), testId]);
    if (f.marks_obtained !== undefined && f.marks_obtained !== null && money(rows[0].marks_obtained) === null) {
      await notifyStudent(e.student_id, `Your result for "${f.title || rows[0].title}" is in: ${marks} / ${max}.`);
    }
    res.json({ message: 'Test updated.' });
  } catch (err) {
    sendError(res, err, 'Could not update the test.', 'Update my student test error:');
  }
});

router.delete('/:id/tests/:testId', async (req, res) => {
  try {
    const e = await ownedEnrollment(req);
    const testId = id(req.params.testId);
    const [r] = testId ? await db.query('DELETE FROM student_tests WHERE id = ? AND enrollment_id = ?', [testId, e.id]) : [{ affectedRows: 0 }];
    if (r.affectedRows === 0) throw new StudentError(404, 'Test not found.', 'NOT_FOUND');
    res.json({ message: 'Test deleted.' });
  } catch (err) {
    sendError(res, err, 'Could not delete the test.', 'Delete my student test error:');
  }
});

// =====================================================================
// PRIVATE NOTES
// =====================================================================
router.get('/:id/notes', async (req, res) => {
  try {
    const e = await ownedEnrollment(req);
    const [rows] = await db.query(
      'SELECT id, note, created_at FROM student_notes WHERE enrollment_id = ? ORDER BY created_at DESC, id DESC LIMIT 200',
      [e.id]
    );
    res.json(rows);
  } catch (err) {
    sendError(res, err, 'Could not load notes.', 'Get my student notes error:');
  }
});

router.post('/:id/notes', async (req, res) => {
  try {
    const e = await ownedEnrollment(req);
    const note = text((req.body || {}).note, 2000, 'Note', { required: true });
    const [r] = await db.query('INSERT INTO student_notes (enrollment_id, note) VALUES (?, ?)', [e.id, note]);
    res.status(201).json({ id: r.insertId, message: 'Note saved.' });
  } catch (err) {
    sendError(res, err, 'Could not save the note.', 'Add my student note error:');
  }
});

router.delete('/:id/notes/:noteId', async (req, res) => {
  try {
    const e = await ownedEnrollment(req);
    const noteId = id(req.params.noteId);
    const [r] = noteId ? await db.query('DELETE FROM student_notes WHERE id = ? AND enrollment_id = ?', [noteId, e.id]) : [{ affectedRows: 0 }];
    if (r.affectedRows === 0) throw new StudentError(404, 'Note not found.', 'NOT_FOUND');
    res.json({ message: 'Note deleted.' });
  } catch (err) {
    sendError(res, err, 'Could not delete the note.', 'Delete my student note error:');
  }
});

// =====================================================================
// HOMEWORK
// =====================================================================
async function notifyStudent(studentId, message) {
  try {
    const [rows] = await db.query('SELECT user_id FROM students WHERE id = ?', [studentId]);
    if (rows.length > 0) await createNotification(rows[0].user_id, message, 'courses.html');
  } catch (err) {
    console.error('Notify student error:', err);
  }
}

router.get('/:id/assignments', async (req, res) => {
  try {
    const e = await ownedEnrollment(req);
    const [rows] = await db.query(
      `SELECT a.id, a.course_id, a.title, a.instructions, a.due_date, a.status,
              c.title AS course_title,
              sub.status AS submission_status, sub.submission_text, sub.feedback, sub.submitted_at, sub.reviewed_at
       FROM assignments a
       JOIN courses c ON c.id = a.course_id
       LEFT JOIN assignment_submissions sub ON sub.assignment_id = a.id AND sub.student_id = ?
       WHERE c.enrollment_id = ?
       ORDER BY a.due_date IS NULL, a.due_date DESC, a.id DESC`,
      [e.student_id, e.id]
    );
    res.json(rows);
  } catch (err) {
    sendError(res, err, 'Could not load homework.', 'Get my student assignments error:');
  }
});

router.post('/:id/assignments', async (req, res) => {
  try {
    const e = await ownedEnrollment(req);
    const body = req.body || {};
    const title = text(body.title, 255, 'Title', { required: true });
    const instructions = text(body.instructions, 3000, 'Instructions');
    const dueDate = date(body.due_date, 'Due date', { required: false });
    if (dueDate && dueDate < rules.todayInTz()) throw bad('The due date cannot be in the past.');

    let courseId = body.course_id === undefined || body.course_id === null || body.course_id === '' ? null : id(body.course_id);
    if (body.course_id !== undefined && body.course_id !== null && body.course_id !== '' && !courseId) throw bad('Invalid course.');
    const [courses] = await db.query(
      "SELECT id FROM courses WHERE enrollment_id = ? ORDER BY (status = 'active') DESC, id ASC",
      [e.id]
    );
    if (courseId) {
      if (!courses.some((c) => c.id === courseId)) throw bad('That course does not belong to this student.');
    } else if (courses.length > 0) {
      courseId = courses[0].id;
    } else {
      throw bad('Create a course for this student before giving homework.', 'NO_COURSE');
    }

    const [r] = await db.query(
      "INSERT INTO assignments (course_id, title, instructions, due_date, status) VALUES (?, ?, ?, ?, 'published')",
      [courseId, title, instructions, dueDate]
    );
    await notifyStudent(e.student_id, `New homework from your teacher: ${title}${dueDate ? ` (due ${dueDate})` : ''}.`);
    res.status(201).json({ id: r.insertId, message: 'Homework assigned.' });
  } catch (err) {
    sendError(res, err, 'Could not assign the homework.', 'Add my student assignment error:');
  }
});

async function ownedAssignment(e, assignmentId) {
  const aid = id(assignmentId);
  if (!aid) throw new StudentError(404, 'Homework not found.', 'NOT_FOUND');
  const [rows] = await db.query(
    `SELECT a.id, a.title FROM assignments a JOIN courses c ON c.id = a.course_id WHERE a.id = ? AND c.enrollment_id = ?`,
    [aid, e.id]
  );
  if (rows.length === 0) throw new StudentError(404, 'Homework not found.', 'NOT_FOUND');
  return rows[0];
}

// Teacher marks a piece of homework as checked, with optional feedback.
router.put('/:id/assignments/:assignmentId/review', async (req, res) => {
  try {
    const e = await ownedEnrollment(req);
    const a = await ownedAssignment(e, req.params.assignmentId);
    const feedback = text((req.body || {}).feedback, 1000, 'Feedback');
    const [existing] = await db.query('SELECT id FROM assignment_submissions WHERE assignment_id = ? AND student_id = ?', [a.id, e.student_id]);
    if (existing.length > 0) {
      await db.query(
        "UPDATE assignment_submissions SET status = 'reviewed', feedback = ?, reviewed_at = NOW() WHERE id = ?",
        [feedback, existing[0].id]
      );
    } else {
      await db.query(
        "INSERT INTO assignment_submissions (assignment_id, student_id, status, feedback, reviewed_at) VALUES (?, ?, 'reviewed', ?, NOW())",
        [a.id, e.student_id, feedback]
      );
    }
    await notifyStudent(e.student_id, `Your teacher checked your homework: ${a.title}.`);
    res.json({ message: 'Homework marked as checked.' });
  } catch (err) {
    sendError(res, err, 'Could not save the review.', 'Review my student assignment error:');
  }
});

router.delete('/:id/assignments/:assignmentId', async (req, res) => {
  try {
    const e = await ownedEnrollment(req);
    const a = await ownedAssignment(e, req.params.assignmentId);
    await db.query('DELETE FROM assignments WHERE id = ?', [a.id]);
    res.json({ message: 'Homework deleted.' });
  } catch (err) {
    sendError(res, err, 'Could not delete the homework.', 'Delete my student assignment error:');
  }
});

module.exports = router;