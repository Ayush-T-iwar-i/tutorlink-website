const cron = require('node-cron');
const db = require('../config/db');
const { sendMail } = require('../config/email');
const { sendSms } = require('../config/sms');
const emailTemplates = require('../config/email-templates');
const { createNotification } = require('../routes/notification.routes');
const rules = require('../lib/booking-rules');

// Turns "5:00 PM" into { hours, minutes } in 24-hour time.
// Returns null if the string can't be parsed, so callers can skip it safely.
function parseTimeString(timeStr) {
  if (!timeStr) return null;
  const match = timeStr.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) return null;

  let hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  const meridiem = match[3].toUpperCase();

  if (meridiem === 'PM' && hours !== 12) hours += 12;
  if (meridiem === 'AM' && hours === 12) hours = 0;

  return { hours, minutes };
}

async function sendDueReminders() {
  try {
    // "Today" is evaluated in APP_TIMEZONE, not the server's or MySQL's timezone.
    const today = rules.todayInTz();

    // Sessions scheduled and not yet reminded, dated today or tomorrow —
    // narrowed further below once times are parsed, since MySQL doesn't
    // know how to compare our text time format directly.
    const [sessions] = await db.query(
      `SELECT cs.id, cs.session_date, cs.session_time, cs.booking_id,
              b.subject, u1.name AS student_name, u1.email AS student_email, u1.phone AS student_phone,
              u2.name AS teacher_name, u2.email AS teacher_email, u2.phone AS teacher_phone
       FROM class_sessions cs
       JOIN bookings b ON b.id = cs.booking_id
       JOIN students s ON s.id = b.student_id
       JOIN users u1 ON u1.id = s.user_id
       JOIN teachers t ON t.id = b.teacher_id
       JOIN users u2 ON u2.id = t.user_id
       WHERE cs.status = 'scheduled' AND cs.reminder_sent = 0
         AND cs.session_date BETWEEN ? AND ?`,
      [today, rules.addDays(today, 1)]
    );

    for (const session of sessions) {
      // Only remind for sessions starting within the next 2 hours (and not
      // already started, in case the cron missed a run)
      const minsAway = rules.minutesUntil(session.session_date, session.session_time);
      if (minsAway === null || minsAway < 0 || minsAway > 120) continue;

      const whenText = `${session.session_time} ${session.session_date === today ? 'today' : 'tomorrow'}`;

      // Claim the session first so a second server instance (or an overlapping run) cannot send the
      // same reminder; release the claim if sending fails so the next run retries it.
      const [claim] = await db.query(
        'UPDATE class_sessions SET reminder_sent = 1 WHERE id = ? AND reminder_sent = 0',
        [session.id]
      );
      if (claim.affectedRows === 0) continue;

      try {
        const studentEmail = emailTemplates.classReminderStudent({
          studentName: session.student_name,
          teacherName: session.teacher_name,
          whenText,
        });
        await sendMail({ to: session.student_email, subject: studentEmail.subject, html: studentEmail.html });

        const teacherEmail = emailTemplates.classReminderTeacher({
          teacherName: session.teacher_name,
          studentName: session.student_name,
          whenText,
        });
        await sendMail({ to: session.teacher_email, subject: teacherEmail.subject, html: teacherEmail.html });

        if (session.student_phone) {
          await sendSms(session.student_phone, `TutorLink: reminder — your class is at ${whenText}.`);
        }
        if (session.teacher_phone) {
          await sendSms(session.teacher_phone, `TutorLink: reminder — your class is at ${whenText}.`);
        }
      } catch (sendErr) {
        console.error(`[reminders] sending reminder for session ${session.id} failed:`, sendErr);
        await db.query('UPDATE class_sessions SET reminder_sent = 0 WHERE id = ?', [session.id]);
      }
    }

    if (sessions.length > 0) {
      console.log(`[reminders] checked ${sessions.length} upcoming session(s)`);
    }
  } catch (err) {
    console.error('Class reminder job failed:', err);
  }
}

// Runs every 15 minutes. Never throws — a failed run just tries again
// next tick, and never blocks server startup or requests.
function startReminderJob() {
  cron.schedule('*/15 * * * *', sendDueReminders);
  console.log('✅ Class reminder job scheduled (every 15 minutes)');
}

module.exports = { startReminderJob, sendDueReminders, parseTimeString };