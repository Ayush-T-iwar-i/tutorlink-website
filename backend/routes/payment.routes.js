const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../config/db');
const { razorpay, isConfigured } = require('../config/razorpay');
const { verifyToken, requireRole, requireVerifiedEmail } = require('../middleware/auth.middleware');
const payments = require('../lib/payments');
const { withTransaction } = require('../lib/tx');
const { runAfterResponse } = require('../lib/after-response');
const { notifyTeacherPaid, refundAndNotify } = require('../lib/payment-jobs');

class PaymentError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function sendError(res, err, fallback, label) {
  if (err instanceof PaymentError) return res.status(err.status).json({ error: err.message, code: err.code });
  console.error(label, err);
  if (res.headersSent) return undefined;
  return res.status(500).json({ error: fallback, code: 'INTERNAL_ERROR' });
}

const isId = (v) => Number.isInteger(v) && v > 0;
const isShortString = (v) => typeof v === 'string' && v.length > 0 && v.length <= 100;

// After a capture has been applied, do whatever follow-up the outcome needs (notify / refund).
function scheduleFollowUps(res, result) {
  if (result.outcome === 'paid') {
    runAfterResponse(res, 'Payment notification', () => notifyTeacherPaid(result.bookingId));
  }
  if (result.refundPaymentId) {
    const reason = result.outcome === 'duplicate' ? 'duplicate_payment' : 'booking_not_active';
    runAfterResponse(res, 'Refund', () => refundAndNotify(result.refundPaymentId, reason));
  }
}

// ---------- CREATE A RAZORPAY ORDER FOR A BOOKING ----------
// POST /api/payments/create-order        body: { booking_id }
// The amount is ALWAYS taken from bookings.fee in the database. Calling this repeatedly (double click,
// page refresh) re-uses the open order instead of creating a new one.
router.post('/create-order', verifyToken, requireRole('student'), requireVerifiedEmail, async (req, res) => {
  if (!isConfigured) {
    return res.status(503).json({
      error: 'Online payments are not set up yet. Please ask the teacher to accept manual payment for now.',
      code: 'PAYMENTS_DISABLED',
    });
  }
  const bookingId = Number(req.body && req.body.booking_id);
  if (!isId(bookingId)) return res.status(400).json({ error: 'A valid booking_id is required.', code: 'VALIDATION_ERROR' });

  try {
    const order = await withTransaction(db, async (conn) => {
      const [rows] = await conn.query(
        `SELECT b.id, b.fee, b.payment_status, b.status
         FROM bookings b JOIN students s ON s.id = b.student_id
         WHERE b.id = ? AND s.user_id = ?
         FOR UPDATE OF b`,
        [bookingId, req.user.id]
      );
      if (rows.length === 0) throw new PaymentError(403, 'This is not your booking.', 'FORBIDDEN');

      const booking = rows[0];
      if (booking.status !== 'accepted' && booking.status !== 'completed') {
        throw new PaymentError(400, 'This booking has not been accepted by the teacher yet.', 'BOOKING_NOT_ACCEPTED');
      }
      if (booking.payment_status !== 'unpaid') {
        throw new PaymentError(400, 'This booking is already paid.', 'ALREADY_PAID');
      }
      const amountPaise = payments.toPaise(booking.fee);
      if (amountPaise === 0) {
        throw new PaymentError(400, 'The teacher has not set a payable fee for this booking yet.', 'NO_FEE');
      }

      const [open] = await conn.query(
        `SELECT razorpay_order_id, amount_paise FROM payments
         WHERE booking_id = ? AND method = 'razorpay' AND status = 'created'
         ORDER BY id DESC LIMIT 1 FOR UPDATE`,
        [bookingId]
      );
      if (open.length > 0 && open[0].amount_paise === amountPaise) {
        return { order_id: open[0].razorpay_order_id, amount: amountPaise, currency: payments.CURRENCY };
      }

      const created = await razorpay.orders.create({
        amount: amountPaise,
        currency: payments.CURRENCY,
        receipt: `booking_${bookingId}`,
        notes: { booking_id: String(bookingId) },
      });
      if (!created || typeof created.id !== 'string' || Number(created.amount) !== amountPaise) {
        throw new PaymentError(502, 'The payment provider returned an unexpected response. Please try again.', 'GATEWAY_ERROR');
      }

      await conn.query(
        `INSERT INTO payments (booking_id, method, status, amount_paise, currency, razorpay_order_id)
         VALUES (?, 'razorpay', 'created', ?, ?, ?)`,
        [bookingId, amountPaise, payments.CURRENCY, created.id]
      );
      await conn.query('UPDATE bookings SET razorpay_order_id = ? WHERE id = ?', [created.id, bookingId]);
      return { order_id: created.id, amount: amountPaise, currency: payments.CURRENCY };
    });

    res.json({ ...order, key_id: process.env.RAZORPAY_KEY_ID });
  } catch (err) {
    sendError(res, err, 'Could not start payment. Please try again.', 'Create Razorpay order error:');
  }
});

// ---------- CONFIRM A PAYMENT AFTER RAZORPAY CHECKOUT ----------
// POST /api/payments/verify
// body: { booking_id, razorpay_order_id, razorpay_payment_id, razorpay_signature }
// 1) the checkout signature must be valid, 2) the payment is fetched from Razorpay and must be captured
// for THIS order with the amount we ordered. Only then is the booking marked paid.
// Replies 202 when Razorpay has not captured yet — the webhook completes it automatically.
router.post('/verify', verifyToken, requireRole('student'), async (req, res) => {
  const body = req.body || {};
  const bookingId = Number(body.booking_id);
  const { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = body;

  if (!isId(bookingId) || !isShortString(orderId) || !isShortString(paymentId) || !isShortString(signature)) {
    return res.status(400).json({ error: 'Missing payment details.', code: 'VALIDATION_ERROR' });
  }
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!secret) return res.status(503).json({ error: 'Payment verification is not configured.', code: 'PAYMENTS_DISABLED' });

  if (!payments.verifyCheckoutSignature(orderId, paymentId, signature, secret)) {
    return res.status(400).json({
      error: 'Payment verification failed. If money was deducted, contact support.',
      code: 'BAD_SIGNATURE',
    });
  }

  try {
    const [owned] = await db.query(
      `SELECT p.id FROM payments p
       JOIN bookings b ON b.id = p.booking_id
       JOIN students s ON s.id = b.student_id
       WHERE p.razorpay_order_id = ? AND b.id = ? AND s.user_id = ?`,
      [orderId, bookingId, req.user.id]
    );
    if (owned.length === 0) throw new PaymentError(403, 'Booking/order mismatch.', 'FORBIDDEN');

    let gatewayPayment;
    try {
      gatewayPayment = await razorpay.payments.fetch(paymentId);
    } catch (fetchErr) {
      console.error('Razorpay fetch payment failed:', (fetchErr && fetchErr.message) || fetchErr);
      return res.status(202).json({ status: 'pending', message: 'We have received your payment and are confirming it. This page will update shortly.' });
    }
    if (!gatewayPayment || gatewayPayment.order_id !== orderId) {
      throw new PaymentError(400, 'Payment does not belong to this order.', 'ORDER_MISMATCH');
    }
    if (gatewayPayment.status === 'failed') {
      throw new PaymentError(400, 'The payment failed. You have not been charged. Please try again.', 'PAYMENT_FAILED');
    }
    if (gatewayPayment.status !== 'captured') {
      return res.status(202).json({ status: 'pending', message: 'Your payment is still being processed. This page will update shortly.' });
    }

    const result = await withTransaction(db, (conn) => payments.applyCapturedPayment(conn, {
      orderId,
      paymentId,
      amountPaise: gatewayPayment.amount,
      currency: gatewayPayment.currency,
    }));

    if (result.outcome === 'amount_mismatch' || result.outcome === 'conflict') {
      console.error(`ACTION REQUIRED: payment ${paymentId} for order ${orderId} was ${result.outcome}.`);
      throw new PaymentError(409, 'We could not match this payment to your booking. Please contact support with your payment id.', 'PAYMENT_MISMATCH');
    }
    if (result.outcome === 'unknown_order') throw new PaymentError(403, 'Booking/order mismatch.', 'FORBIDDEN');

    if (result.outcome === 'duplicate' || result.outcome === 'paid_after_cancel') {
      res.json({ status: 'refund_initiated', message: 'This booking was no longer payable, so your payment is being refunded automatically.' });
    } else {
      res.json({ status: 'paid', message: 'Payment verified successfully.' });
    }
    scheduleFollowUps(res, result);
  } catch (err) {
    sendError(res, err, 'Could not verify payment.', 'Verify payment error:');
  }
});

// ---------- RAZORPAY WEBHOOK ----------
// POST /api/payments/webhook   (no login — authenticated by the HMAC signature over the RAW body)
// server.js parses this path with express.raw() so the bytes are exactly what Razorpay signed.
// Every event id is recorded in the same transaction that processes it, so redelivery is a no-op, and
// a processing failure rolls the record back so Razorpay's retry is handled properly.
async function handleWebhookEvent(conn, event) {
  const payload = event.payload || {};
  const paymentEntity = payload.payment && payload.payment.entity;
  const refundEntity = payload.refund && payload.refund.entity;

  switch (event.event) {
    case 'payment.captured':
    case 'order.paid': {
      if (!paymentEntity || !paymentEntity.order_id) return { handled: false };
      if (paymentEntity.status && paymentEntity.status !== 'captured') return { handled: false };
      return payments.applyCapturedPayment(conn, {
        orderId: paymentEntity.order_id,
        paymentId: paymentEntity.id,
        amountPaise: paymentEntity.amount,
        currency: paymentEntity.currency,
      });
    }
    case 'payment.failed': {
      // The student can retry on the same order, so a failed attempt is only recorded, not terminal.
      if (paymentEntity && paymentEntity.order_id) {
        const reason = String(paymentEntity.error_description || paymentEntity.error_reason || 'payment_failed').slice(0, 255);
        await conn.query("UPDATE payments SET failure_reason = ? WHERE razorpay_order_id = ? AND status = 'created'", [reason, paymentEntity.order_id]);
      }
      return { handled: true };
    }
    case 'refund.processed': {
      if (!refundEntity || !refundEntity.payment_id) return { handled: false };
      const [rows] = await conn.query('SELECT * FROM payments WHERE razorpay_payment_id = ? FOR UPDATE', [refundEntity.payment_id]);
      const p = rows[0];
      if (!p || p.status === 'refunded') return { handled: true };
      if (Number(refundEntity.amount) < p.amount_paise) {
        // Partial refunds are not part of the product; keep the record untouched but visible.
        await conn.query('UPDATE payments SET failure_reason = ? WHERE id = ?', ['partial_refund_seen_in_gateway', p.id]);
        return { handled: true };
      }
      await conn.query(
        "UPDATE payments SET status = 'refunded', razorpay_refund_id = COALESCE(razorpay_refund_id, ?), refunded_at = COALESCE(refunded_at, NOW()) WHERE id = ?",
        [refundEntity.id, p.id]
      );
      if (p.status === 'paid' || p.status === 'refund_pending') {
        await conn.query("UPDATE bookings SET payment_status = 'refunded' WHERE id = ?", [p.booking_id]);
      }
      return { handled: true };
    }
    default:
      return { handled: false };
  }
}

router.post('/webhook', async (req, res) => {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) {
    console.error('Razorpay webhook received but RAZORPAY_WEBHOOK_SECRET is not configured.');
    return res.status(503).json({ error: 'Webhook not configured.', code: 'WEBHOOK_DISABLED' });
  }
  const raw = req.body;
  if (!Buffer.isBuffer(raw) || raw.length === 0) return res.status(400).json({ error: 'Invalid body.', code: 'VALIDATION_ERROR' });

  if (!payments.verifyWebhookSignature(raw, req.get('x-razorpay-signature'), secret)) {
    return res.status(400).json({ error: 'Invalid signature.', code: 'BAD_SIGNATURE' });
  }

  let event;
  try {
    event = JSON.parse(raw.toString('utf8'));
  } catch (_) {
    return res.status(400).json({ error: 'Invalid JSON.', code: 'VALIDATION_ERROR' });
  }
  if (!event || typeof event.event !== 'string') return res.status(400).json({ error: 'Invalid event.', code: 'VALIDATION_ERROR' });

  const eventId = String(req.get('x-razorpay-event-id') || crypto.createHash('sha256').update(raw).digest('hex')).slice(0, 100);

  try {
    const result = await withTransaction(db, async (conn) => {
      const [inserted] = await conn.query(
        'INSERT IGNORE INTO payment_events (event_id, event_type) VALUES (?, ?)',
        [eventId, event.event.slice(0, 60)]
      );
      if (inserted.affectedRows === 0) return { duplicate: true };
      return handleWebhookEvent(conn, event);
    });

    if (result.outcome === 'amount_mismatch' || result.outcome === 'conflict') {
      console.error(`ACTION REQUIRED: webhook payment for order was ${result.outcome} (event ${eventId}).`);
    }
    // Always 200 once the signature is valid and the event is recorded, so Razorpay stops retrying.
    res.status(200).json({ received: true, duplicate: Boolean(result.duplicate) });
    if (!result.duplicate) scheduleFollowUps(res, result);
  } catch (err) {
    // 5xx makes Razorpay retry later — correct for transient failures such as a database outage.
    console.error('Webhook processing error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Webhook processing failed.', code: 'INTERNAL_ERROR' });
  }
});

// ---------- PAYMENT STATUS OF A BOOKING (for the UI to poll after a 202) ----------
// GET /api/payments/booking/:id   — the student or the teacher of that booking only
router.get('/booking/:id', verifyToken, async (req, res) => {
  const bookingId = Number(req.params.id);
  if (!isId(bookingId)) return res.status(400).json({ error: 'Invalid booking id.', code: 'VALIDATION_ERROR' });
  try {
    const [rows] = await db.query(
      `SELECT b.payment_status FROM bookings b
       JOIN students s ON s.id = b.student_id
       JOIN teachers t ON t.id = b.teacher_id
       WHERE b.id = ? AND (s.user_id = ? OR t.user_id = ?)`,
      [bookingId, req.user.id, req.user.id]
    );
    if (rows.length === 0) return res.status(403).json({ error: 'You can only view payments for your own bookings.', code: 'FORBIDDEN' });
    res.json({ payment_status: rows[0].payment_status });
  } catch (err) {
    console.error('Payment status error:', err);
    res.status(500).json({ error: 'Could not load payment status.', code: 'INTERNAL_ERROR' });
  }
});

module.exports = router;