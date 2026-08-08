const cron = require('node-cron');
const db = require('../config/db');
const { sendMail } = require('../config/email');
const { sendSms } = require('../config/sms');
const emailTemplates = require('../config/email-templates');
const { createNotification } = require('../routes/notification.routes');

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
         AND cs.session_date BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 1 DAY)`
    );

    const now = new Date();
    const twoHoursFromNow = new Date(now.getTime() + 2 * 60 * 60 * 1000);

    for (const session of sessions) {
      const time = parseTimeString(session.session_time);
      if (!time) continue;

      const sessionDateTime = new Date(session.session_date);
      sessionDateTime.setHours(time.hours, time.minutes, 0, 0);

      // Only remind for sessions happening in the next 2 hours (and not
      // already in the past, in case the cron missed a run)
      if (sessionDateTime < now || sessionDateTime > twoHoursFromNow) continue;

      const whenText = `${session.session_time} today`;

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

      await db.query('UPDATE class_sessions SET reminder_sent = 1 WHERE id = ?', [session.id]);
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