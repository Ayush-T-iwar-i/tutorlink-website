/**
 * Payment business logic shared by the payment routes, the booking routes (cancellation refunds)
 * and the admin routes. The pure helpers (signatures, paise, refund window) are unit-tested; the
 * database functions are exercised against real MySQL in tests/integration/payment.integration.test.js.
 *
 * Trust model: nothing the browser says about money is believed.
 *  - The amount charged always comes from bookings.fee in OUR database.
 *  - A payment is only marked paid after (a) a valid Razorpay signature AND the payment is fetched
 *    from Razorpay's API and found captured with the right order/amount/currency, or (b) a
 *    signature-verified webhook. Both paths funnel into applyCapturedPayment(), which is idempotent.
 */
const crypto = require('crypto');
const rules = require('./booking-rules');
const { withTransaction } = require('./tx');

const CURRENCY = 'INR';
const DEFAULT_REFUND_WINDOW_HOURS = 24;

/** Rupees (number | decimal string) -> integer paise. Returns 0 for anything not a positive amount. */
function toPaise(rupees) {
  // Number.EPSILON nudges binary-float artefacts (1.005 * 100 = 100.49999...) across the rounding line.
  const n = Math.round((Number(rupees) + Number.EPSILON) * 100);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/** Signature Razorpay Checkout returns to the browser: HMAC_SHA256(order_id|payment_id, key_secret). */
function checkoutSignature(orderId, paymentId, secret) {
  return crypto.createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');
}

function verifyCheckoutSignature(orderId, paymentId, signature, secret) {
  if (!secret || !orderId || !paymentId) return false;
  return safeEqual(checkoutSignature(orderId, paymentId, secret), signature);
}

/** Webhook signature: HMAC_SHA256(raw request body, webhook_secret), compared timing-safely. */
function verifyWebhookSignature(rawBody, signature, secret) {
  if (!secret || !rawBody || !signature) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return safeEqual(expected, signature);
}

function refundWindowHours() {
  const n = Number(process.env.REFUND_WINDOW_HOURS);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_REFUND_WINDOW_HOURS;
}

/** Is a student-initiated cancellation early enough for an automatic refund? */
function isWithinRefundWindow(booking, now = new Date()) {
  if (!booking.booking_date) return true;
  const mins = rules.minutesUntil(booking.booking_date, booking.booking_time, now);
  if (mins === null) return true;
  return mins / 60 >= refundWindowHours();
}

/**
 * A Razorpay payment was captured for `orderId`. Marks our payment + booking paid exactly once.
 * Must be called inside a transaction (`conn`). Safe to call repeatedly and concurrently.
 *
 * outcome:
 *   paid               newly marked paid
 *   already_processed  this exact payment was handled before (idempotent no-op)
 *   paid_after_cancel  booking was cancelled/declined meanwhile -> refund started (refundPaymentId)
 *   duplicate          booking already settled by another payment -> refund started (refundPaymentId)
 *   amount_mismatch    amount/currency differ from what we ordered -> NOT marked paid, needs a human
 *   conflict           the order already holds a different captured payment
 *   unknown_order      we never created this order
 */
async function applyCapturedPayment(conn, { orderId, paymentId, amountPaise, currency }) {
  const [rows] = await conn.query('SELECT * FROM payments WHERE razorpay_order_id = ? FOR UPDATE', [orderId]);
  if (rows.length === 0) return { outcome: 'unknown_order' };
  const payment = rows[0];
  const base = { bookingId: payment.booking_id, paymentRowId: payment.id };

  if (payment.razorpay_payment_id === paymentId) return { outcome: 'already_processed', ...base };
  if (payment.razorpay_payment_id && payment.razorpay_payment_id !== paymentId) return { outcome: 'conflict', ...base };

  if (Number(amountPaise) !== payment.amount_paise || String(currency).toUpperCase() !== payment.currency) {
    await conn.query('UPDATE payments SET failure_reason = ? WHERE id = ?', [
      `amount_mismatch: gateway reported ${amountPaise} ${currency}, expected ${payment.amount_paise} ${payment.currency}`.slice(0, 255),
      payment.id,
    ]);
    return { outcome: 'amount_mismatch', ...base };
  }

  const [bookings] = await conn.query('SELECT id, status, payment_status FROM bookings WHERE id = ? FOR UPDATE', [payment.booking_id]);
  const booking = bookings[0];

  // Booking already settled by a different payment: this one is a double charge.
  if (booking.payment_status === 'paid') {
    await conn.query(
      "UPDATE payments SET status = 'duplicate', razorpay_payment_id = ?, paid_at = NOW() WHERE id = ?",
      [paymentId, payment.id]
    );
    return { outcome: 'duplicate', refundPaymentId: payment.id, ...base };
  }

  // Money arrived for a booking that is no longer active: keep the record, return the money.
  if (booking.status === 'cancelled' || booking.status === 'declined') {
    await conn.query(
      "UPDATE payments SET status = 'refund_pending', razorpay_payment_id = ?, paid_at = NOW() WHERE id = ?",
      [paymentId, payment.id]
    );
    await conn.query("UPDATE bookings SET payment_status = 'paid', razorpay_payment_id = ? WHERE id = ?", [paymentId, booking.id]);
    return { outcome: 'paid_after_cancel', refundPaymentId: payment.id, ...base };
  }

  await conn.query(
    "UPDATE payments SET status = 'paid', razorpay_payment_id = ?, paid_at = NOW(), failure_reason = NULL WHERE id = ?",
    [paymentId, payment.id]
  );
  await conn.query("UPDATE bookings SET payment_status = 'paid', razorpay_payment_id = ? WHERE id = ?", [paymentId, booking.id]);
  return { outcome: 'paid', ...base };
}

/**
 * Called inside the cancellation transaction for a booking that was paid.
 * Decides what happens to the money and (for eligible online payments) flips the payment to
 * refund_pending atomically with the cancellation. The actual gateway call happens after commit.
 *
 * refund: none | initiated | not_eligible | manual
 */
async function startRefundForCancelledBooking(conn, booking, cancelledBy, now = new Date()) {
  if (booking.payment_status !== 'paid') return { refund: 'none' };

  const [rows] = await conn.query("SELECT * FROM payments WHERE booking_id = ? AND status = 'paid' FOR UPDATE", [booking.id]);
  const payment = rows[0];
  if (!payment || payment.method !== 'razorpay') return { refund: 'manual' }; // cash: settled between the two people

  const eligible = cancelledBy === 'teacher' || isWithinRefundWindow(booking, now);
  if (!eligible) return { refund: 'not_eligible' };

  await conn.query("UPDATE payments SET status = 'refund_pending' WHERE id = ?", [payment.id]);
  return { refund: 'initiated', refundPaymentId: payment.id };
}

/**
 * Send the refund to Razorpay for a payment in refund_pending / duplicate state.
 * Runs in its own transaction holding the payment row lock, so two callers can never refund the same
 * payment twice. On gateway failure nothing changes and the payment stays pending for a retry
 * (admin endpoint) — it is never silently dropped.
 *
 * outcome: refunded | nothing_to_do | manual_required | gateway_unavailable | failed | not_found
 */
async function processRefund(db, razorpay, paymentRowId, reason = 'booking_cancelled') {
  return withTransaction(db, async (conn) => {
    const [rows] = await conn.query('SELECT * FROM payments WHERE id = ? FOR UPDATE', [paymentRowId]);
    const payment = rows[0];
    if (!payment) return { outcome: 'not_found' };
    if (payment.status !== 'refund_pending' && payment.status !== 'duplicate') return { outcome: 'nothing_to_do', status: payment.status };
    if (payment.method !== 'razorpay' || !payment.razorpay_payment_id) return { outcome: 'manual_required' };
    if (!razorpay) return { outcome: 'gateway_unavailable' };

    let refund;
    try {
      refund = await razorpay.payments.refund(payment.razorpay_payment_id, {
        amount: payment.amount_paise,
        notes: { booking_id: String(payment.booking_id), reason },
      });
    } catch (err) {
      const detail = (err && err.error && err.error.description) || (err && err.message) || 'unknown gateway error';
      console.error(`Refund for payment #${payment.id} failed:`, detail);
      await conn.query('UPDATE payments SET failure_reason = ? WHERE id = ?', [`refund_failed: ${detail}`.slice(0, 255), payment.id]);
      return { outcome: 'failed', error: detail };
    }

    await conn.query(
      "UPDATE payments SET status = 'refunded', razorpay_refund_id = ?, refunded_at = NOW(), failure_reason = NULL WHERE id = ?",
      [refund.id, payment.id]
    );
    if (payment.status === 'refund_pending') {
      await conn.query("UPDATE bookings SET payment_status = 'refunded' WHERE id = ?", [payment.booking_id]);
    }
    return { outcome: 'refunded', refundId: refund.id, bookingId: payment.booking_id, amountPaise: payment.amount_paise };
  });
}

module.exports = {
  CURRENCY, toPaise,
  checkoutSignature, verifyCheckoutSignature, verifyWebhookSignature,
  refundWindowHours, isWithinRefundWindow,
  applyCapturedPayment, startRefundForCancelledBooking, processRefund,
};