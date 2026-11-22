const cron = require('node-cron');
const db = require('../config/db');
const { createNotification } = require('../routes/notification.routes');
const rules = require('../lib/booking-rules');

const REMIND_DAYS_BEFORE_END = 3;

/**
 * Tells the student and the teacher once, a few days before a monthly plan ends, so the student
 * can renew. A plan that was already renewed (or has a renewal request waiting) is skipped.
 * Never throws: a failed run is simply tried again on the next tick.
 */
async function sendPlanEndingReminders(now = new Date()) {
  try {
    const today = rules.todayInTz(now);
    const lastDay = rules.addDays(today, REMIND_DAYS_BEFORE_END);

    const [plans] = await db.query(
      `SELECT b.id, b.subject, b.booking_date, b.duration_months,
              su.id AS student_user_id, su.name AS student_name,
              tu.id AS teacher_user_id, tu.name AS teacher_name
       FROM bookings b
       JOIN students s ON s.id = b.student_id
       JOIN users su ON su.id = s.user_id
       JOIN teachers t ON t.id = b.teacher_id
       JOIN users tu ON tu.id = t.user_id
       WHERE b.type = 'recurring' AND b.status = 'accepted' AND b.plan_reminded = 0
         AND b.booking_date <= ?
         AND NOT EXISTS (
           SELECT 1 FROM bookings n
           WHERE n.continued_from = b.id AND n.status IN ('requested', 'accepted', 'completed')
         )`,
      [lastDay]
    );

    let sent = 0;
    for (const p of plans) {
      const end = rules.planEndDate({ type: 'recurring', booking_date: p.booking_date, duration_months: p.duration_months });
      if (!end || end < today || end > lastDay) continue;

      // Claim first so two server instances (or overlapping runs) never send it twice.
      const [claim] = await db.query('UPDATE bookings SET plan_reminded = 1 WHERE id = ? AND plan_reminded = 0', [p.id]);
      if (claim.affectedRows === 0) continue;

      await createNotification(
        p.student_user_id,
        `Your ${p.subject} plan with ${p.teacher_name} ends on ${end}. Renew to keep your classes going.`,
        'student-dashboard.html#classes'
      );
      await createNotification(
        p.teacher_user_id,
        `${p.student_name}'s ${p.subject} plan ends on ${end}. They have been reminded to renew.`,
        'teacher-dashboard.html'
      );
      sent++;
    }
    if (sent > 0) console.log(`[plan-reminders] reminded ${sent} plan(s)`);
    return sent;
  } catch (err) {
    console.error('Plan reminder job failed:', err);
    return 0;
  }
}

// Every 6 hours (so a sleeping free-tier server still catches up). Each plan is reminded only once.
function startPlanReminderJob() {
  cron.schedule('0 */6 * * *', () => sendPlanEndingReminders());
  console.log('✅ Plan-ending reminder job scheduled (every 6 hours)');
}

module.exports = { startPlanReminderJob, sendPlanEndingReminders };