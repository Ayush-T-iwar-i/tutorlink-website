/**
 * Work that happens AFTER a payment transaction has committed: sending the refund to the gateway
 * and telling people about it. Kept out of the transactions so a slow email never holds a DB lock.
 */
const db = require('../config/db');
const { razorpay } = require('../config/razorpay');
const { sendMail } = require('../config/email');
const emailTemplates = require('../config/email-templates');
const { createNotification } = require('../routes/notification.routes');
const payments = require('./payments');

const rupees = (paise) => (paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

/** Tell the teacher a student paid. */
async function notifyTeacherPaid(bookingId) {
  const [rows] = await db.query(
    `SELECT t.user_id, u.name, u.email FROM bookings b
     JOIN teachers t ON t.id = b.teacher_id
     JOIN users u ON u.id = t.user_id
     WHERE b.id = ?`,
    [bookingId]
  );
  if (rows.length === 0) return;
  await createNotification(rows[0].user_id, 'A student paid for their class.', 'teacher-dashboard.html');
  const { subject, html } = emailTemplates.paymentReceived({ teacherName: rows[0].name });
  await sendMail({ to: rows[0].email, subject, html });
}

/** Execute a pending refund at the gateway, then tell the student. Never throws. */
async function refundAndNotify(paymentRowId, reason) {
  try {
    const result = await payments.processRefund(db, razorpay, paymentRowId, reason);
    if (result.outcome === 'refunded') {
      const [rows] = await db.query(
        `SELECT s.user_id FROM bookings b JOIN students s ON s.id = b.student_id WHERE b.id = ?`,
        [result.bookingId]
      );
      if (rows.length > 0) {
        await createNotification(
          rows[0].user_id,
          `Your refund of ₹${rupees(result.amountPaise)} has been issued. It can take 5-7 working days to reach your account.`,
          'student-dashboard.html'
        );
      }
    } else if (result.outcome === 'failed' || result.outcome === 'manual_required' || result.outcome === 'gateway_unavailable') {
      // Visible in logs for the operator; the payment stays in refund_pending and can be retried
      // from the admin refund endpoint.
      console.error(`ACTION REQUIRED: refund for payment #${paymentRowId} not completed (${result.outcome}).`);
    }
    return result;
  } catch (err) {
    console.error(`ACTION REQUIRED: refund job for payment #${paymentRowId} crashed:`, err);
    return { outcome: 'failed' };
  }
}

module.exports = { notifyTeacherPaid, refundAndNotify };