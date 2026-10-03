const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { sendMail } = require('../config/email');
const emailTemplates = require('../config/email-templates');
const { sendSms } = require('../config/sms');
const { createNotification } = require('./notification.routes');
const { verifyToken, requireRole } = require('../middleware/auth.middleware');
const rules = require('../lib/booking-rules');
const { withTransaction } = require('../lib/tx');
const { runAfterResponse } = require('../lib/after-response');

const MAX_FEE = 100000;

// An expected, user-facing failure (bad input, conflict, forbidden). Anything else is a 500.
class BookingError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function sendError(res, err, fallbackMessage, logLabel) {
  if (err instanceof BookingError) {
    return res.status(err.status).json({ error: err.message, code: err.code });
  }
  console.error(logLabel, err);
  if (res.headersSent) return undefined;
  return res.status(500).json({ error: fallbackMessage, code: 'INTERNAL_ERROR' });
}

// Turn an accepted booking into dated class sessions, using the caller's transaction.
// Demo -> one session. Recurring -> every matching weekday for RECURRING_WEEKS weeks.
// INSERT IGNORE + the (booking_id, session_date, session_time) unique key make this idempotent.
async function generateClassSessions(conn, bookingId, booking) {
  const startDate = booking.booking_date || rules.todayInTz();
  const time = rules.normalizeSlot(booking.booking_time) || '10:00 AM';
  const dates = rules.occurrenceDates({ ...booking, booking_date: startDate });
  if (dates.length === 0) return;
  await conn.query(
    'INSERT IGNORE INTO class_sessions (booking_id, session_date, session_time) VALUES ?',
    [dates.map((d) => [bookingId, d, time])]
  );
}

// The conflict window: any active booking that could overlap the dates of a candidate.
function conflictWindow(candidate) {
  const dates = rules.occurrenceDates(candidate);
  const last = dates[dates.length - 1] || candidate.booking_date;
  return {
    from: rules.addDays(candidate.booking_date, -(rules.RECURRING_WEEKS * 7)),
    to: last,
  };
}

// ---------- CREATE A BOOKING (protected: must be a logged-in student) ----------
// POST /api/bookings
// body: { teacher_id, type, subject, booking_date, booking_time, days_per_week }
// `fee` is intentionally ignored: the teacher sets it when accepting.
//
// Concurrency: the teacher's row and the student's row are locked (always in that order)
// for the duration of the transaction, so two simultaneous requests for the same slot are
// serialised and exactly one wins. The unique `slot_key` index is a second, database-level guard.
router.post('/', verifyToken, requireRole('student'), async (req, res) => {
  const parsed = rules.validateNewBooking(req.body);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error, code: parsed.code });
  const input = parsed.value;

  try {
    const created = await withTransaction(db, async (conn) => {
      const [teacherRows] = await conn.query(
        'SELECT id, user_id, verification_status, available_slots FROM teachers WHERE id = ? FOR UPDATE',
        [input.teacher_id]
      );
      if (teacherRows.length === 0 || teacherRows[0].verification_status !== 'approved') {
        throw new BookingError(404, 'Teacher not found.', 'TEACHER_NOT_FOUND');
      }
      const teacher = teacherRows[0];

      if (!rules.teacherSlotList(teacher.available_slots).includes(input.booking_time)) {
        throw new BookingError(400, 'This teacher does not offer that time slot.', 'SLOT_NOT_OFFERED');
      }

      const [studentRows] = await conn.query('SELECT id FROM students WHERE user_id = ? FOR UPDATE', [req.user.id]);
      if (studentRows.length === 0) {
        throw new BookingError(404, 'Student profile not found. Please complete your profile first.', 'STUDENT_PROFILE_MISSING');
      }
      const studentId = studentRows[0].id;

      const win = conflictWindow(input);
      const [active] = await conn.query(
        `SELECT id, student_id, teacher_id, type, booking_date, booking_time, days_per_week
         FROM bookings
         WHERE status IN ('requested', 'accepted')
           AND (teacher_id = ? OR student_id = ?)
           AND booking_date IS NOT NULL AND booking_date BETWEEN ? AND ?`,
        [input.teacher_id, studentId, win.from, win.to]
      );
      for (const row of active) {
        if (!rules.bookingsConflict(input, row)) continue;
        if (row.teacher_id === input.teacher_id) {
          if (row.student_id === studentId) {
            throw new BookingError(409, 'You already have a request for this time with this teacher.', 'DUPLICATE_BOOKING');
          }
          throw new BookingError(409, 'That slot is no longer available. Please pick another time.', 'SLOT_TAKEN');
        }
        throw new BookingError(409, 'You already have another class booked at that time.', 'STUDENT_BUSY');
      }

      let result;
      try {
        [result] = await conn.query(
          `INSERT INTO bookings
             (student_id, teacher_id, type, subject, booking_date, booking_time, days_per_week, fee)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
          [studentId, input.teacher_id, input.type, input.subject, input.booking_date, input.booking_time, input.days_per_week]
        );
      } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
          throw new BookingError(409, 'That slot is no longer available. Please pick another time.', 'SLOT_TAKEN');
        }
        throw err;
      }
      return { bookingId: result.insertId, teacherUserId: teacher.user_id };
    });

    res.status(201).json({ message: 'Booking request sent.', booking_id: created.bookingId });

    runAfterResponse(res, 'New-booking notification', () => notifyNewBooking(created.teacherUserId, req.user.id, input));
  } catch (err) {
    sendError(res, err, 'Could not create booking.', 'Create booking error:');
  }
});

async function notifyNewBooking(teacherUserId, studentUserId, input) {
  const [[teacher]] = await db.query('SELECT name, email, phone FROM users WHERE id = ?', [teacherUserId]);
  const [[student]] = await db.query('SELECT name FROM users WHERE id = ?', [studentUserId]);
  const studentName = (student && student.name) || 'A student';
  if (!teacher) return;

  await createNotification(
    teacherUserId,
    `${studentName} requested a ${input.type} class for ${input.subject}.`,
    'teacher-dashboard.html'
  );
  const { subject, html } = emailTemplates.newBookingRequest({
    teacherName: teacher.name,
    studentName,
    type: input.type,
    subject: input.subject,
    date: input.booking_date,
    time: input.booking_time,
  });
  await sendMail({ to: teacher.email, subject, html });
  if (teacher.phone) {
    await sendSms(teacher.phone, `TutorLink: ${studentName} requested a ${input.type} class. Log in to accept/decline.`);
  }
}

// ---------- WHICH SLOTS ARE FREE FOR A TEACHER ON A DATE ----------
// GET /api/bookings/availability/:teacherId?date=YYYY-MM-DD
// Lets the UI grey out slots that are taken or already past. Purely advisory — POST /api/bookings
// re-checks everything under a lock. Reveals only free/taken, never who booked.
router.get('/availability/:teacherId', verifyToken, async (req, res) => {
  try {
    const teacherId = Number(req.params.teacherId);
    const date = req.query.date;
    if (!Number.isInteger(teacherId) || teacherId < 1) return res.status(400).json({ error: 'Invalid teacher id.', code: 'VALIDATION_ERROR' });
    if (!rules.isValidDateString(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD.', code: 'VALIDATION_ERROR' });

    const [teacherRows] = await db.query(
      `SELECT id, available_slots FROM teachers WHERE id = ? AND verification_status = 'approved'`,
      [teacherId]
    );
    if (teacherRows.length === 0) return res.status(404).json({ error: 'Teacher not found.', code: 'TEACHER_NOT_FOUND' });

    const [active] = await db.query(
      `SELECT type, booking_date, booking_time, days_per_week FROM bookings
       WHERE teacher_id = ? AND status IN ('requested', 'accepted')
         AND booking_date IS NOT NULL AND booking_date BETWEEN ? AND ?`,
      [teacherId, rules.addDays(date, -(rules.RECURRING_WEEKS * 7)), date]
    );
    const taken = new Set(
      active
        .filter((b) => rules.occurrenceDates(b).includes(date))
        .map((b) => rules.normalizeSlot(b.booking_time))
    );

    const slots = rules.teacherSlotList(teacherRows[0].available_slots).map((slot) => ({
      slot,
      available: !taken.has(slot) && !rules.isInPast(date, slot),
    }));
    res.json({ date, slots });
  } catch (err) {
    console.error('Availability error:', err);
    res.status(500).json({ error: 'Could not load availability.', code: 'INTERNAL_ERROR' });
  }
});

// ---------- STUDENT: CANCEL THEIR OWN BOOKING ----------
// PUT /api/bookings/:id/cancel
// Only 'requested' or 'accepted' bookings can be cancelled (see STUDENT_TRANSITIONS).
router.put('/:id/cancel', verifyToken, requireRole('student'), async (req, res) => {
  const bookingId = Number(req.params.id);
  if (!Number.isInteger(bookingId) || bookingId < 1) {
    return res.status(400).json({ error: 'Invalid booking id.', code: 'VALIDATION_ERROR' });
  }

  try {
    const outcome = await withTransaction(db, async (conn) => {
      const [rows] = await conn.query(
        `SELECT b.id, b.status, b.teacher_id, b.payment_status
         FROM bookings b
         JOIN students s ON s.id = b.student_id
         WHERE b.id = ? AND s.user_id = ?
         FOR UPDATE OF b`,
        [bookingId, req.user.id]
      );
      if (rows.length === 0) throw new BookingError(403, 'You can only cancel your own bookings.', 'FORBIDDEN');

      const booking = rows[0];
      if (!rules.canTransition(rules.STUDENT_TRANSITIONS, booking.status, 'cancelled')) {
        throw new BookingError(409, `Cannot cancel a booking that is already '${booking.status}'.`, 'INVALID_TRANSITION');
      }

      await conn.query("UPDATE bookings SET status = 'cancelled' WHERE id = ?", [bookingId]);
      await conn.query("UPDATE class_sessions SET status = 'cancelled' WHERE booking_id = ? AND status = 'scheduled'", [bookingId]);
      await conn.query("UPDATE enrollments SET status = 'cancelled' WHERE booking_id = ? AND status = 'active'", [bookingId]);
      return booking;
    });

    res.json({ message: 'Booking cancelled.', needs_refund: outcome.payment_status === 'paid' });

    runAfterResponse(res, 'Cancel-booking notification', async () => {
      const [teacherRows] = await db.query('SELECT user_id FROM teachers WHERE id = ?', [outcome.teacher_id]);
      const [studentRows] = await db.query('SELECT name FROM users WHERE id = ?', [req.user.id]);
      if (teacherRows.length > 0) {
        await createNotification(
          teacherRows[0].user_id,
          `${(studentRows[0] && studentRows[0].name) || 'A student'} cancelled their booking.`,
          'teacher-dashboard.html'
        );
      }
    });
  } catch (err) {
    sendError(res, err, 'Could not cancel booking.', 'Cancel booking error:');
  }
});

// ---------- TEACHER: ACCEPT / DECLINE / COMPLETE / CANCEL A BOOKING ----------
// PUT /api/bookings/:id/status
// body: { status: "accepted" | "declined" | "completed" | "cancelled", fee }
// Allowed moves (TEACHER_TRANSITIONS): requested -> accepted | declined ; accepted -> completed | cancelled.
// Accepting sets the fee, creates the class sessions and the enrollment/course in ONE transaction.
router.put('/:id/status', verifyToken, requireRole('teacher'), async (req, res) => {
  const bookingId = Number(req.params.id);
  const { status, fee } = req.body || {};

  if (!Number.isInteger(bookingId) || bookingId < 1) {
    return res.status(400).json({ error: 'Invalid booking id.', code: 'VALIDATION_ERROR' });
  }
  const allowed = ['accepted', 'declined', 'completed', 'cancelled'];
  if (!allowed.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${allowed.join(', ')}`, code: 'VALIDATION_ERROR' });
  }

  let feeValue = 0;
  if (status === 'accepted') {
    const n = typeof fee === 'string' && fee.trim() !== '' ? Number(fee) : fee;
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > MAX_FEE) {
      return res.status(400).json({
        error: `Please set a fee between 0 and ${MAX_FEE} (0 is fine for a free demo) when accepting.`,
        code: 'VALIDATION_ERROR',
      });
    }
    feeValue = Math.round(n * 100) / 100;
  }

  try {
    const outcome = await withTransaction(db, async (conn) => {
      const [rows] = await conn.query(
        `SELECT b.id, b.status, b.type, b.booking_date, b.booking_time, b.days_per_week,
                b.student_id, b.teacher_id, b.subject, b.payment_status
         FROM bookings b
         JOIN teachers t ON t.id = b.teacher_id
         WHERE b.id = ? AND t.user_id = ?
         FOR UPDATE OF b`,
        [bookingId, req.user.id]
      );
      if (rows.length === 0) throw new BookingError(403, 'You can only update your own booking requests.', 'FORBIDDEN');

      const booking = rows[0];
      if (!rules.canTransition(rules.TEACHER_TRANSITIONS, booking.status, status)) {
        throw new BookingError(409, `A '${booking.status}' booking cannot be marked '${status}'.`, 'INVALID_TRANSITION');
      }

      if (status === 'accepted' && booking.booking_date && rules.isInPast(booking.booking_date, booking.booking_time)) {
        throw new BookingError(400, 'The requested class time has already passed. Please decline this request.', 'SLOT_IN_PAST');
      }
      if (status === 'completed' && booking.booking_date) {
        const mins = rules.minutesUntil(booking.booking_date, booking.booking_time);
        if (mins !== null && mins > 0) {
          throw new BookingError(400, 'A class can only be marked completed after it has started.', 'NOT_STARTED');
        }
      }

      if (status === 'accepted') {
        await conn.query("UPDATE bookings SET status = 'accepted', fee = ? WHERE id = ?", [feeValue, bookingId]);
        await generateClassSessions(conn, bookingId, booking);

        // Active-tuition relationship: an enrollment plus a default course.
        const [existing] = await conn.query('SELECT id FROM enrollments WHERE booking_id = ?', [bookingId]);
        if (existing.length === 0) {
          const subject = booking.subject || 'General';
          const start = booking.booking_date || rules.todayInTz();
          const [enroll] = await conn.query(
            `INSERT INTO enrollments (student_id, teacher_id, booking_id, subject, status, start_date)
             VALUES (?, ?, ?, ?, 'active', ?)`,
            [booking.student_id, booking.teacher_id, bookingId, subject, start]
          );
          await conn.query(
            `INSERT INTO courses (enrollment_id, title, subject, status, start_date)
             VALUES (?, ?, ?, 'active', ?)`,
            [enroll.insertId, `${subject} Tuition`, subject, start]
          );
        }
      } else {
        await conn.query('UPDATE bookings SET status = ? WHERE id = ?', [status, bookingId]);
        if (status === 'declined' || status === 'cancelled') {
          await conn.query("UPDATE class_sessions SET status = 'cancelled' WHERE booking_id = ? AND status = 'scheduled'", [bookingId]);
          await conn.query("UPDATE enrollments SET status = 'cancelled' WHERE booking_id = ? AND status = 'active'", [bookingId]);
        } else {
          await conn.query("UPDATE class_sessions SET status = 'completed' WHERE booking_id = ? AND status = 'scheduled'", [bookingId]);
          await conn.query("UPDATE enrollments SET status = 'completed' WHERE booking_id = ? AND status = 'active'", [bookingId]);
        }
      }
      return booking;
    });

    res.json({
      message: `Booking marked as ${status}.`,
      needs_refund: status === 'cancelled' && outcome.payment_status === 'paid',
    });

    if (['accepted', 'declined', 'cancelled'].includes(status)) {
      runAfterResponse(res, 'Booking-status notification', () => notifyStudentOfStatus(bookingId, status));
    }
  } catch (err) {
    sendError(res, err, 'Could not update booking status.', 'Update booking status error:');
  }
});

async function notifyStudentOfStatus(bookingId, status) {
  const [rows] = await db.query(
    `SELECT u.id AS user_id, u.email, u.name, u.phone FROM bookings b
     JOIN students s ON s.id = b.student_id
     JOIN users u ON u.id = s.user_id
     WHERE b.id = ?`,
    [bookingId]
  );
  if (rows.length === 0) return;
  const student = rows[0];

  await createNotification(student.user_id, `Your booking was ${status} by the teacher.`, 'student-dashboard.html');
  const { subject, html } = emailTemplates.bookingStatusChanged({ studentName: student.name, status });
  await sendMail({ to: student.email, subject, html });
  if (student.phone) await sendSms(student.phone, `TutorLink: Your class was ${status} by the teacher.`);
}

// `SELECT b.*` also returns internal columns; never send those to clients.
function stripInternal(row) {
  const { slot_key, ...rest } = row; // eslint-disable-line no-unused-vars
  return rest;
}

// ---------- GET ALL BOOKINGS FOR THE LOGGED-IN STUDENT ----------
// GET /api/bookings/student/me
router.get('/student/me', verifyToken, requireRole('student'), async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT b.*, u.name AS teacher_name, u.id AS teacher_user_id,
              r.id AS review_id, r.rating AS review_rating, r.comment AS review_comment,
              r.created_at AS review_created_at, r.teacher_reply, r.teacher_reply_at
       FROM bookings b
       JOIN teachers t ON t.id = b.teacher_id
       JOIN users u ON u.id = t.user_id
       JOIN students s ON s.id = b.student_id
       LEFT JOIN reviews r ON r.booking_id = b.id
       WHERE s.user_id = ?
       ORDER BY b.created_at DESC`,
      [req.user.id]
    );
    res.json(rows.map(stripInternal));
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
      `SELECT b.*, u.name AS student_name, u.id AS student_user_id
       FROM bookings b
       JOIN students s ON s.id = b.student_id
       JOIN users u ON u.id = s.user_id
       JOIN teachers t ON t.id = b.teacher_id
       WHERE t.user_id = ?
       ORDER BY b.created_at DESC`,
      [req.user.id]
    );
    res.json(rows.map(stripInternal));
  } catch (err) {
    console.error('Get teacher bookings error:', err);
    res.status(500).json({ error: 'Could not fetch bookings.' });
  }
});

// ---------- TEACHER: MARK A BOOKING AS PAID/UNPAID/REFUNDED ----------
// PUT /api/bookings/:id/payment
// body: { payment_status: "unpaid" | "paid" | "refunded" }
router.put('/:id/payment', verifyToken, requireRole('teacher'), async (req, res) => {
  try {
    const { id } = req.params;
    const { payment_status } = req.body;
    const allowed = ['unpaid', 'paid', 'refunded'];

    if (!allowed.includes(payment_status)) {
      return res.status(400).json({ error: `payment_status must be one of: ${allowed.join(', ')}` });
    }

    const [rows] = await db.query(
      `SELECT b.id FROM bookings b
       JOIN teachers t ON t.id = b.teacher_id
       WHERE b.id = ? AND t.user_id = ?`,
      [id, req.user.id]
    );
    if (rows.length === 0) {
      return res.status(403).json({ error: 'You can only update your own booking requests.' });
    }

    await db.query('UPDATE bookings SET payment_status = ? WHERE id = ?', [payment_status, id]);
    res.json({ message: `Payment marked as ${payment_status}.` });
  } catch (err) {
    console.error('Update payment status error:', err);
    res.status(500).json({ error: 'Could not update payment status.' });
  }
});

// ---------- TEACHER: EARNINGS SUMMARY ----------
// GET /api/bookings/teacher/earnings
router.get('/teacher/earnings', verifyToken, requireRole('teacher'), async (req, res) => {
  try {
    const [[totals]] = await db.query(
      `SELECT
         COALESCE(SUM(CASE WHEN b.payment_status = 'paid' THEN b.fee ELSE 0 END), 0) AS total_earned,
         COALESCE(SUM(CASE WHEN b.payment_status = 'paid' AND MONTH(b.booking_date) = MONTH(CURDATE()) AND YEAR(b.booking_date) = YEAR(CURDATE()) THEN b.fee ELSE 0 END), 0) AS this_month,
         COALESCE(SUM(CASE WHEN b.status = 'completed' AND b.payment_status = 'unpaid' THEN b.fee ELSE 0 END), 0) AS pending_amount,
         COUNT(CASE WHEN b.status = 'completed' THEN 1 END) AS completed_count
       FROM bookings b
       JOIN teachers t ON t.id = b.teacher_id
       WHERE t.user_id = ?`,
      [req.user.id]
    );

    const [recent] = await db.query(
      `SELECT b.id, b.subject, b.fee, b.payment_status, b.booking_date, u.name AS student_name
       FROM bookings b
       JOIN students s ON s.id = b.student_id
       JOIN users u ON u.id = s.user_id
       JOIN teachers t ON t.id = b.teacher_id
       WHERE t.user_id = ? AND b.status = 'completed'
       ORDER BY b.booking_date DESC LIMIT 10`,
      [req.user.id]
    );

    res.json({ ...totals, recent });
  } catch (err) {
    console.error('Get earnings error:', err);
    res.status(500).json({ error: 'Could not fetch earnings.' });
  }
});

// ---------- LIST A BOOKING'S CLASS SESSIONS (participant only) ----------
// GET /api/bookings/:id/sessions
router.get('/:id/sessions', verifyToken, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT s.user_id AS student_user_id, t.user_id AS teacher_user_id
       FROM bookings b
       JOIN students s ON s.id = b.student_id
       JOIN teachers t ON t.id = b.teacher_id
       WHERE b.id = ?`,
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Booking not found.' });

    const isParticipant = req.user.id === rows[0].student_user_id || req.user.id === rows[0].teacher_user_id;
    if (!isParticipant) return res.status(403).json({ error: 'You are not part of this booking.' });

    const [sessions] = await db.query(
      'SELECT * FROM class_sessions WHERE booking_id = ? ORDER BY session_date ASC',
      [req.params.id]
    );
    res.json(sessions);
  } catch (err) {
    console.error('Get class sessions error:', err);
    res.status(500).json({ error: 'Could not fetch sessions.' });
  }
});

// ---------- TEACHER: NEXT 7 DAYS OF SCHEDULED CLASS SESSIONS ----------
// GET /api/bookings/teacher/schedule
router.get('/teacher/schedule', verifyToken, requireRole('teacher'), async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT cs.id AS session_id, cs.session_date, cs.session_time, cs.booking_id,
              b.subject, b.type, u.name AS student_name
       FROM class_sessions cs
       JOIN bookings b ON b.id = cs.booking_id
       JOIN students s ON s.id = b.student_id
       JOIN users u ON u.id = s.user_id
       JOIN teachers t ON t.id = b.teacher_id
       WHERE t.user_id = ?
         AND cs.status = 'scheduled'
         AND cs.session_date BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 7 DAY)
       ORDER BY cs.session_date ASC, cs.session_time ASC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    console.error('Get teacher schedule error:', err);
    res.status(500).json({ error: 'Could not fetch schedule.' });
  }
});

module.exports = router;