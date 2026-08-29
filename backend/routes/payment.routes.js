const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../config/db');
const { razorpay, isConfigured } = require('../config/razorpay');
const { sendMail } = require('../config/email');
const emailTemplates = require('../config/email-templates');
const { createNotification } = require('./notification.routes');
const { verifyToken, requireRole } = require('../middleware/auth.middleware');

// ---------- CREATE A RAZORPAY ORDER FOR A BOOKING ----------
// POST /api/payments/create-order
// body: { booking_id }
router.post('/create-order', verifyToken, requireRole('student'), async (req, res) => {
  try {
    if (!isConfigured) {
      return res.status(503).json({ error: 'Online payments are not set up yet. Please ask the teacher to accept manual payment for now.' });
    }

    const { booking_id } = req.body;
    if (!booking_id) return res.status(400).json({ error: 'booking_id is required.' });

    const [rows] = await db.query(
      `SELECT b.id, b.fee, b.payment_status, b.status
       FROM bookings b JOIN students s ON s.id = b.student_id
       WHERE b.id = ? AND s.user_id = ?`,
      [booking_id, req.user.id]
    );
    if (rows.length === 0) return res.status(403).json({ error: 'This is not your booking.' });

    const booking = rows[0];
    if (booking.status !== 'accepted' && booking.status !== 'completed') {
      return res.status(400).json({ error: 'This booking has not been accepted by the teacher yet.' });
    }
    if (booking.payment_status === 'paid') {
      return res.status(400).json({ error: 'This booking is already paid.' });
    }
    if (!booking.fee || Number(booking.fee) <= 0) {
      return res.status(400).json({ error: 'The teacher has not set a payable fee for this booking yet.' });
    }

    const order = await razorpay.orders.create({
      amount: Math.round(Number(booking.fee) * 100), // paise
      currency: 'INR',
      receipt: `booking_${booking_id}`,
      notes: { booking_id: String(booking_id) },
    });

    await db.query('UPDATE bookings SET razorpay_order_id = ? WHERE id = ?', [order.id, booking_id]);

    res.json({
      order_id: order.id,
      amount: order.amount,
      currency: order.currency,
      key_id: process.env.RAZORPAY_KEY_ID,
    });
  } catch (err) {
    console.error('Create Razorpay order error:', err);
    res.status(500).json({ error: 'Could not start payment. Please try again.' });
  }
});

// ---------- VERIFY PAYMENT AFTER RAZORPAY CHECKOUT SUCCEEDS ----------
// POST /api/payments/verify
// body: { booking_id, razorpay_order_id, razorpay_payment_id, razorpay_signature }
router.post('/verify', verifyToken, requireRole('student'), async (req, res) => {
  try {
    const { booking_id, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    if (!booking_id || !razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ error: 'Missing payment details.' });
    }

    if (!process.env.RAZORPAY_KEY_SECRET) {
      return res.status(500).json({ error: 'Payment verification secret is not configured.' });
    }

    // Recompute signature and compare timing-safely to prevent side-channel timing attacks
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    const expectedBuf = Buffer.from(expectedSignature, 'utf8');
    const receivedBuf = Buffer.from(razorpay_signature, 'utf8');

    const isMatch = expectedBuf.length === receivedBuf.length && crypto.timingSafeEqual(expectedBuf, receivedBuf);

    if (!isMatch) {
      return res.status(400).json({ error: 'Payment verification failed. If money was deducted, contact support.' });
    }

    const [rows] = await db.query(
      `SELECT b.id FROM bookings b JOIN students s ON s.id = b.student_id
       WHERE b.id = ? AND s.user_id = ? AND b.razorpay_order_id = ?`,
      [booking_id, req.user.id, razorpay_order_id]
    );
    if (rows.length === 0) return res.status(403).json({ error: 'Booking/order mismatch.' });

    await db.query(
      'UPDATE bookings SET payment_status = ?, razorpay_payment_id = ? WHERE id = ?',
      ['paid', razorpay_payment_id, booking_id]
    );

    res.json({ message: 'Payment verified successfully.' });

    try {
      const [teacherUser] = await db.query(
        `SELECT t.user_id, u.name, u.email FROM bookings b
         JOIN teachers t ON t.id = b.teacher_id
         JOIN users u ON u.id = t.user_id
         WHERE b.id = ?`,
        [booking_id]
      );
      if (teacherUser.length > 0) {
        await createNotification(teacherUser[0].user_id, 'A student paid for their class.', 'teacher-dashboard.html');
        const { subject, html } = emailTemplates.paymentReceived({ teacherName: teacherUser[0].name });
        await sendMail({ to: teacherUser[0].email, subject, html });
      }
    } catch (notifyErr) {
      console.error('Payment confirmation notification failed:', notifyErr);
    }
  } catch (err) {
    console.error('Verify payment error:', err);
    if (res.headersSent) return;
    res.status(500).json({ error: 'Could not verify payment.' });
  }
});

module.exports = router;