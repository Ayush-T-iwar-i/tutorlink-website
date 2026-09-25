const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { sendMail } = require('../config/email');
const emailTemplates = require('../config/email-templates');
const { sendSms } = require('../config/sms');
const { createNotification } = require('./notification.routes');
const { verifyToken, requireRole } = require('../middleware/auth.middleware');

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const RECURRING_WEEKS = 8; // how many weeks ahead to generate sessions for

// Demo booking -> exactly one session on its booking_date.
// Recurring booking -> one session per matching weekday for the next
// RECURRING_WEEKS weeks, starting from booking_date.
async function generateClassSessions(bookingId, booking) {
  try {
    const [existing] = await db.query('SELECT id FROM class_sessions WHERE booking_id = ?', [bookingId]);
    if (existing.length > 0) return;

    const sessions = [];

    if (booking.type === 'recurring' && booking.days_per_week) {
      const wantedDays = booking.days_per_week.split(',').map(d => d.trim());
      const startDate = booking.booking_date ? new Date(booking.booking_date) : new Date();
      const totalDays = RECURRING_WEEKS * 7;

      for (let i = 0; i < totalDays; i++) {
        const d = new Date(startDate);
        d.setDate(d.getDate() + i);
        const dayName = WEEKDAY_NAMES[d.getDay()];
        if (wantedDays.includes(dayName)) {
          sessions.push([bookingId, d.toISOString().split('T')[0], booking.booking_time || '10:00 AM']);
        }
      }
    } else {
      const sessionDate = booking.booking_date ? new Date(booking.booking_date).toISOString().split('T')[0] : new Date().toISOString().split('T')[0];
      sessions.push([bookingId, sessionDate, booking.booking_time || '10:00 AM']);
    }

    if (sessions.length === 0) return;

    await db.query(
      `INSERT INTO class_sessions (booking_id, session_date, session_time) VALUES ?`,
      [sessions]
    );
  } catch (err) {
    console.error('Generate class sessions error:', err);
  }
}

// ---------- CREATE A BOOKING (protected: must be a logged-in student) ----------
// POST /api/bookings
// header: Authorization: Bearer <token>
// body: { teacher_id, type, subject, booking_date, booking_time, days_per_week, fee }
router.post('/', verifyToken, requireRole('student'), async (req, res) => {
  try {
    const { teacher_id, type, subject, booking_date, booking_time, days_per_week, fee } = req.body;

    if (!teacher_id) {
      return res.status(400).json({ error: 'teacher_id is required.' });
    }

    // Look up the student's own student_id from their logged-in user id
    const [studentRows] = await db.query('SELECT id FROM students WHERE user_id = ?', [req.user.id]);
    if (studentRows.length === 0) {
      return res.status(404).json({ error: 'Student profile not found. Please complete your profile first.' });
    }
    const studentId = studentRows[0].id;

    // Verify teacher exists and is approved
    const [teacherCheck] = await db.query('SELECT id, verification_status FROM teachers WHERE id = ?', [teacher_id]);
    if (teacherCheck.length === 0) {
      return res.status(404).json({ error: 'Teacher not found.' });
    }

    const [result] = await db.query(
      `INSERT INTO bookings
        (student_id, teacher_id, type, subject, booking_date, booking_time, days_per_week, fee)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [studentId, teacher_id, type || 'demo', subject || 'General', booking_date || null, booking_time || null, days_per_week || null, Math.max(0, parseFloat(fee) || 0)]
    );

    res.status(201).json({ message: 'Booking request sent.', booking_id: result.insertId });

    // Notify the teacher
    try {
      const [teacherRows] = await db.query(
        `SELECT u.email, u.name, u.phone FROM teachers t JOIN users u ON u.id = t.user_id WHERE t.id = ?`,
        [teacher_id]
      );
      const [studentRowsData] = await db.query('SELECT name FROM users WHERE id = ?', [req.user.id]);
      if (teacherRows.length > 0) {
        const { subject: emailSubject, html } = emailTemplates.newBookingRequest({
          teacherName: teacherRows[0].name,
          studentName: studentRowsData[0]?.name || 'A student',
          type,
          subject,
          date: booking_date,
          time: booking_time,
        });
        await sendMail({ to: teacherRows[0].email, subject: emailSubject, html });
      }

      const [teacherUserId] = await db.query('SELECT user_id FROM teachers WHERE id = ?', [teacher_id]);
      if (teacherUserId.length > 0) {
        await createNotification(
          teacherUserId[0].user_id,
          `${studentRowsData[0]?.name || 'A student'} requested a ${type || 'demo'} class${subject ? ' for ' + subject : ''}.`,
          'teacher-dashboard.html'
        );
      }

      if (teacherRows.length > 0 && teacherRows[0].phone) {
        await sendSms(
          teacherRows[0].phone,
          `TutorLink: ${studentRowsData[0]?.name || 'A student'} requested a ${type || 'demo'} class. Log in to accept/decline.`
        );
      }
    } catch (emailErr) {
      console.error('Booking notification email failed:', emailErr);
    }
  } catch (err) {
    console.error('Create booking error:', err);
    if (res.headersSent) return;
    res.status(500).json({ error: 'Could not create booking.' });
  }
});

// ---------- STUDENT: CANCEL THEIR OWN BOOKING ----------
// PUT /api/bookings/:id/cancel
// Students can only cancel bookings that are still 'requested' or 'accepted'.
// Completed or declined bookings cannot be cancelled.
router.put('/:id/cancel', verifyToken, requireRole('student'), async (req, res) => {
  try {
    const { id } = req.params;

    // Verify this booking belongs to this student and is in a cancellable state
    const [rows] = await db.query(
      `SELECT b.id, b.status, b.teacher_id
       FROM bookings b
       JOIN students s ON s.id = b.student_id
       WHERE b.id = ? AND s.user_id = ?`,
      [id, req.user.id]
    );

    if (rows.length === 0) {
      return res.status(403).json({ error: 'You can only cancel your own bookings.' });
    }

    const booking = rows[0];
    if (!['requested', 'accepted'].includes(booking.status)) {
      return res.status(400).json({
        error: `Cannot cancel a booking that is already '${booking.status}'.`
      });
    }

    await db.query('UPDATE bookings SET status = ? WHERE id = ?', ['cancelled', id]);
    await db.query("UPDATE class_sessions SET status = 'cancelled' WHERE booking_id = ? AND status = 'scheduled'", [id]);
    await db.query("UPDATE enrollments SET status = 'cancelled' WHERE booking_id = ? AND status = 'active'", [id]);
    res.json({ message: 'Booking cancelled.' });

    // Notify the teacher
    try {
      const [teacherRows] = await db.query(
        `SELECT u.email, u.name, t.user_id FROM teachers t JOIN users u ON u.id = t.user_id WHERE t.id = ?`,
        [booking.teacher_id]
      );
      const [studentName] = await db.query('SELECT name FROM users WHERE id = ?', [req.user.id]);
      if (teacherRows.length > 0) {
        await createNotification(
          teacherRows[0].user_id,
          `${studentName[0]?.name || 'A student'} cancelled their booking request.`,
          'teacher-dashboard.html'
        );
      }
    } catch (notifyErr) {
      console.error('Cancel booking notification failed:', notifyErr);
    }
  } catch (err) {
    console.error('Cancel booking error:', err);
    if (res.headersSent) return;
    res.status(500).json({ error: 'Could not cancel booking.' });
  }
});


// ---------- TEACHER: ACCEPT / DECLINE / COMPLETE A BOOKING ----------
// PUT /api/bookings/:id/status
// body: { status: "accepted" | "declined" | "completed" | "cancelled", fee }
router.put('/:id/status', verifyToken, requireRole('teacher'), async (req, res) => {
  try {
    const { id } = req.params;
    const { status, fee } = req.body;

    const allowed = ['accepted', 'declined', 'completed', 'cancelled'];
    if (!allowed.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${allowed.join(', ')}` });
    }
    if (status === 'accepted' && (fee === undefined || fee === null || Number(fee) < 0)) {
      return res.status(400).json({ error: 'Please set a fee (0 is fine for a free demo) when accepting.' });
    }

    // Confirm ownership
    const [rows] = await db.query(
      `SELECT b.id, b.type, b.booking_date, b.booking_time, b.days_per_week
       FROM bookings b
       JOIN teachers t ON t.id = b.teacher_id
       WHERE b.id = ? AND t.user_id = ?`,
      [id, req.user.id]
    );

    if (rows.length === 0) {
      return res.status(403).json({ error: 'You can only update your own booking requests.' });
    }

    if (status === 'accepted') {
      await db.query('UPDATE bookings SET status = ?, fee = ? WHERE id = ?', [status, Math.max(0, parseFloat(fee) || 0), id]);
      await generateClassSessions(id, rows[0]);

      // --- Auto-create Enrollment + Course (the "Active Tuition" relationship) ---
      try {
        const [bookingData] = await db.query(
          'SELECT student_id, teacher_id, subject, booking_date FROM bookings WHERE id = ?',
          [id]
        );
        if (bookingData.length > 0) {
          const b = bookingData[0];
          // Check if an enrollment already exists for this booking
          const [existingEnrollment] = await db.query(
            'SELECT id FROM enrollments WHERE booking_id = ?', [id]
          );
          if (existingEnrollment.length === 0) {
            const [enrollResult] = await db.query(
              `INSERT INTO enrollments (student_id, teacher_id, booking_id, subject, status, start_date)
               VALUES (?, ?, ?, ?, 'active', COALESCE(?, CURDATE()))`,
              [b.student_id, b.teacher_id, id, b.subject || 'General', b.booking_date]
            );
            // Create a default course for this enrollment
            const courseTitle = `${b.subject || 'General'} Tuition`;
            await db.query(
              `INSERT INTO courses (enrollment_id, title, subject, status, start_date)
               VALUES (?, ?, ?, 'active', COALESCE(?, CURDATE()))`,
              [enrollResult.insertId, courseTitle, b.subject || 'General', b.booking_date]
            );
          }
        }
      } catch (enrollErr) {
        // Enrollment creation failure should not break the booking acceptance flow
        console.error('Auto-create enrollment failed (non-blocking):', enrollErr);
      }
    } else {
      await db.query('UPDATE bookings SET status = ? WHERE id = ?', [status, id]);
      if (['declined', 'cancelled'].includes(status)) {
        await db.query("UPDATE class_sessions SET status = 'cancelled' WHERE booking_id = ? AND status = 'scheduled'", [id]);
        await db.query("UPDATE enrollments SET status = 'cancelled' WHERE booking_id = ? AND status = 'active'", [id]);
      } else if (status === 'completed') {
        await db.query("UPDATE class_sessions SET status = 'completed' WHERE booking_id = ? AND status = 'scheduled'", [id]);
        await db.query("UPDATE enrollments SET status = 'completed' WHERE booking_id = ? AND status = 'active'", [id]);
      }
    }
    res.json({ message: `Booking marked as ${status}.` });

    try {
      const [studentRows] = await db.query(
        `SELECT u.email, u.name, u.phone FROM bookings b
         JOIN students s ON s.id = b.student_id
         JOIN users u ON u.id = s.user_id
         WHERE b.id = ?`,
        [id]
      );
      if (studentRows.length > 0 && ['accepted', 'declined'].includes(status)) {
        const { subject: emailSubject, html } = emailTemplates.bookingStatusChanged({
          studentName: studentRows[0].name,
          status,
        });
        await sendMail({ to: studentRows[0].email, subject: emailSubject, html });
        if (studentRows[0].phone) {
          await sendSms(studentRows[0].phone, `TutorLink: Your class request was ${status} by the teacher.`);
        }
        const [studentUserId] = await db.query(
          `SELECT s.user_id FROM bookings b JOIN students s ON s.id = b.student_id WHERE b.id = ?`,
          [id]
        );
        if (studentUserId.length > 0) {
          await createNotification(
            studentUserId[0].user_id,
            `Your booking request was ${status}.`,
            'student-dashboard.html'
          );
        }
      }
    } catch (emailErr) {
      console.error('Booking status email failed:', emailErr);
    }
  } catch (err) {
    console.error('Update booking status error:', err);
    if (res.headersSent) return;
    res.status(500).json({ error: 'Could not update booking status.' });
  }
});

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
    res.json(rows);
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
    res.json(rows);
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