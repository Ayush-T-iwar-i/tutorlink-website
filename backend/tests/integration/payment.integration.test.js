const crypto = require('crypto');
const request = require('supertest');

// The Razorpay HTTP API is replaced by a mock: no test ever talks to the real gateway.
// Everything else — Express, middleware, SQL, transactions, row locks — is real.
jest.mock('../../config/razorpay', () => ({
  isConfigured: true,
  razorpay: {
    orders: { create: jest.fn() },
    payments: { fetch: jest.fn(), refund: jest.fn() },
  },
}));

const KEY_SECRET = 'test_key_secret';
const WEBHOOK_SECRET = 'whsec_test_secret';
process.env.RAZORPAY_KEY_ID = 'rzp_test_key';
process.env.RAZORPAY_KEY_SECRET = KEY_SECRET;
process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;

const { razorpay } = require('../../config/razorpay');
const app = require('../../server');
const { drain } = require('../../lib/after-response');
const {
  db, auth, createStudent, createTeacher, createAdmin, insertBooking, insertPayment, futureDate,
} = require('./helpers');

afterAll(async () => {
  await drain();
  await db.end();
});

let seq = 0;
const next = () => `${process.pid}_${Date.now() % 100000}_${++seq}`;

beforeEach(() => {
  jest.resetAllMocks();
  razorpay.orders.create.mockImplementation(async ({ amount }) => ({ id: `order_${next()}`, amount, currency: 'INR' }));
  razorpay.payments.refund.mockImplementation(async () => ({ id: `rfnd_${next()}` }));
});

// ---------- helpers ----------
async function acceptedBooking({ fee = 350.5, date = futureDate(5), time = '5:00 PM' } = {}) {
  const student = await createStudent();
  const teacher = await createTeacher();
  const bookingId = await insertBooking({ studentId: student.studentId, teacherId: teacher.teacherId, status: 'accepted', date, time, fee });
  return { student, teacher, bookingId };
}

const createOrder = (student, bookingId, extra = {}) =>
  request(app).post('/api/payments/create-order').set(auth(student.token)).send({ booking_id: bookingId, ...extra });

const sign = (orderId, paymentId) => crypto.createHmac('sha256', KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');

const verify = (student, bookingId, orderId, paymentId, signature = sign(orderId, paymentId)) =>
  request(app).post('/api/payments/verify').set(auth(student.token)).send({
    booking_id: bookingId, razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature,
  });

const gatewayPayment = (orderId, paymentId, patch = {}) => ({
  id: paymentId, order_id: orderId, status: 'captured', amount: 35050, currency: 'INR', ...patch,
});

const capturedEvent = (orderId, paymentId, patch = {}, name = 'payment.captured') => ({
  event: name,
  payload: { payment: { entity: gatewayPayment(orderId, paymentId, patch) } },
});

function webhook(event, { id = `evt_${next()}`, secret = WEBHOOK_SECRET, signBody } = {}) {
  const raw = JSON.stringify(event);
  const signature = crypto.createHmac('sha256', secret).update(signBody !== undefined ? signBody : raw).digest('hex');
  return request(app)
    .post('/api/payments/webhook')
    .set('Content-Type', 'application/json')
    .set('x-razorpay-signature', signature)
    .set('x-razorpay-event-id', id)
    .send(raw);
}

const paymentsOf = async (bookingId) => (await db.query('SELECT * FROM payments WHERE booking_id = ? ORDER BY id', [bookingId]))[0];
const bookingOf = async (bookingId) => (await db.query('SELECT payment_status, razorpay_payment_id FROM bookings WHERE id = ?', [bookingId]))[0][0];
const notificationCount = async (userId) => (await db.query('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ?', [userId]))[0][0].n;

/** A booking with an online payment already settled (ledger + summary column). */
async function paidOnline({ fee = 500, date = futureDate(5), time = '5:00 PM' } = {}) {
  const student = await createStudent();
  const teacher = await createTeacher();
  const bookingId = await insertBooking({ studentId: student.studentId, teacherId: teacher.teacherId, status: 'accepted', date, time, fee, payment: 'paid' });
  const paymentRowId = await insertPayment({ bookingId, method: 'razorpay', status: 'paid', amountPaise: Math.round(fee * 100) });
  return { student, teacher, bookingId, paymentRowId };
}

// =====================================================================
describe('POST /api/payments/create-order', () => {
  it('401 without a token, 403 for a teacher', async () => {
    const { teacher, bookingId } = await acceptedBooking();
    expect((await request(app).post('/api/payments/create-order').send({ booking_id: bookingId })).status).toBe(401);
    expect((await request(app).post('/api/payments/create-order').set(auth(teacher.token)).send({ booking_id: bookingId })).status).toBe(403);
  });

  it.each([[undefined], ['abc'], [0], [-3], [1.5]])('400 for booking_id %p', async (bad) => {
    const student = await createStudent();
    const res = await createOrder(student, bad);
    expect(res.status).toBe(400);
  });

  it("403 for someone else's booking (IDOR) and no order is created", async () => {
    const { bookingId } = await acceptedBooking();
    const intruder = await createStudent();
    const res = await createOrder(intruder, bookingId);
    expect(res.status).toBe(403);
    expect(razorpay.orders.create).not.toHaveBeenCalled();
  });

  it('400 when the booking is not accepted, has no fee, or is already paid', async () => {
    const student = await createStudent();
    const teacher = await createTeacher();
    const requested = await insertBooking({ studentId: student.studentId, teacherId: teacher.teacherId, status: 'requested', date: futureDate(4), fee: 100 });
    expect((await createOrder(student, requested)).body.code).toBe('BOOKING_NOT_ACCEPTED');

    const free = await insertBooking({ studentId: student.studentId, teacherId: teacher.teacherId, status: 'accepted', date: futureDate(5), fee: 0 });
    expect((await createOrder(student, free)).body.code).toBe('NO_FEE');

    const paid = await insertBooking({ studentId: student.studentId, teacherId: teacher.teacherId, status: 'accepted', date: futureDate(6), fee: 100, payment: 'paid' });
    expect((await createOrder(student, paid)).body.code).toBe('ALREADY_PAID');
    expect(razorpay.orders.create).not.toHaveBeenCalled();
  });

  it('charges the fee stored in the database and ignores any amount the client sends', async () => {
    const { student, bookingId } = await acceptedBooking({ fee: 350.5 });
    const res = await createOrder(student, bookingId, { amount: 1, fee: 1, amount_paise: 100 });
    expect(res.status).toBe(200);
    expect(res.body.amount).toBe(35050);
    expect(res.body.currency).toBe('INR');
    expect(res.body.key_id).toBe('rzp_test_key');
    expect(razorpay.orders.create).toHaveBeenCalledWith(expect.objectContaining({ amount: 35050, currency: 'INR' }));
    const rows = await paymentsOf(bookingId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'created', method: 'razorpay', amount_paise: 35050, razorpay_order_id: res.body.order_id });
    expect(JSON.stringify(res.body)).not.toContain(KEY_SECRET);
  });

  it('re-uses the open order on repeat calls instead of creating a new one', async () => {
    const { student, bookingId } = await acceptedBooking();
    const a = await createOrder(student, bookingId);
    const b = await createOrder(student, bookingId);
    expect(b.body.order_id).toBe(a.body.order_id);
    expect(razorpay.orders.create).toHaveBeenCalledTimes(1);
    expect(await paymentsOf(bookingId)).toHaveLength(1);
  });

  it('5 simultaneous requests create exactly one order', async () => {
    razorpay.orders.create.mockImplementation(async ({ amount }) => {
      await new Promise((r) => setTimeout(r, 40));
      return { id: `order_${next()}`, amount, currency: 'INR' };
    });
    const { student, bookingId } = await acceptedBooking();
    const results = await Promise.all(Array.from({ length: 5 }, () => createOrder(student, bookingId)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.body.order_id)).size).toBe(1);
    expect(razorpay.orders.create).toHaveBeenCalledTimes(1);
    expect(await paymentsOf(bookingId)).toHaveLength(1);
  });

  it('502 and no ledger row when the gateway answers with a different amount', async () => {
    razorpay.orders.create.mockResolvedValue({ id: 'order_bad', amount: 1, currency: 'INR' });
    const { student, bookingId } = await acceptedBooking();
    const res = await createOrder(student, bookingId);
    expect(res.status).toBe(502);
    expect(await paymentsOf(bookingId)).toHaveLength(0);
  });
});

// =====================================================================
describe('POST /api/payments/verify', () => {
  async function withOrder(opts) {
    const ctx = await acceptedBooking(opts);
    const order = (await createOrder(ctx.student, ctx.bookingId)).body.order_id;
    return { ...ctx, order, pay: `pay_${next()}` };
  }

  it('400 for missing fields and for a forged signature (gateway never consulted)', async () => {
    const { student, bookingId, order, pay } = await withOrder();
    expect((await request(app).post('/api/payments/verify').set(auth(student.token)).send({ booking_id: bookingId })).status).toBe(400);
    const forged = await verify(student, bookingId, order, pay, 'f'.repeat(64));
    expect(forged.status).toBe(400);
    expect(forged.body.code).toBe('BAD_SIGNATURE');
    expect(razorpay.payments.fetch).not.toHaveBeenCalled();
    expect((await bookingOf(bookingId)).payment_status).toBe('unpaid');
  });

  it("403 when another student tries to confirm someone else's order", async () => {
    const { bookingId, order, pay } = await withOrder();
    const intruder = await createStudent();
    razorpay.payments.fetch.mockResolvedValue(gatewayPayment(order, pay));
    const res = await verify(intruder, bookingId, order, pay);
    expect(res.status).toBe(403);
    expect((await bookingOf(bookingId)).payment_status).toBe('unpaid');
  });

  it('marks the booking paid only after the gateway confirms the capture', async () => {
    const { student, teacher, bookingId, order, pay } = await withOrder();
    razorpay.payments.fetch.mockResolvedValue(gatewayPayment(order, pay));
    const res = await verify(student, bookingId, order, pay);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('paid');
    expect(razorpay.payments.fetch).toHaveBeenCalledWith(pay);
    expect((await bookingOf(bookingId))).toMatchObject({ payment_status: 'paid', razorpay_payment_id: pay });
    const [row] = await paymentsOf(bookingId);
    expect(row).toMatchObject({ status: 'paid', razorpay_payment_id: pay });
    expect(row.paid_at).not.toBeNull();
    await drain();
    expect(await notificationCount(teacher.userId)).toBe(1);
  });

  it('is idempotent: confirming twice keeps one paid row and sends one notification', async () => {
    const { student, teacher, bookingId, order, pay } = await withOrder();
    razorpay.payments.fetch.mockResolvedValue(gatewayPayment(order, pay));
    expect((await verify(student, bookingId, order, pay)).status).toBe(200);
    expect((await verify(student, bookingId, order, pay)).status).toBe(200);
    await drain();
    expect((await paymentsOf(bookingId)).filter((p) => p.status === 'paid')).toHaveLength(1);
    expect(await notificationCount(teacher.userId)).toBe(1);
  });

  it.each([
    ['authorized (not captured yet)', { status: 'authorized' }],
    ['created', { status: 'created' }],
  ])('202 pending and NOT paid while the gateway says %s', async (_n, patch) => {
    const { student, bookingId, order, pay } = await withOrder();
    razorpay.payments.fetch.mockResolvedValue(gatewayPayment(order, pay, patch));
    const res = await verify(student, bookingId, order, pay);
    expect(res.status).toBe(202);
    expect((await bookingOf(bookingId)).payment_status).toBe('unpaid');
  });

  it('202 pending (never a fake success) when the gateway cannot be reached', async () => {
    const { student, bookingId, order, pay } = await withOrder();
    razorpay.payments.fetch.mockRejectedValue(new Error('ETIMEDOUT'));
    const res = await verify(student, bookingId, order, pay);
    expect(res.status).toBe(202);
    expect((await bookingOf(bookingId)).payment_status).toBe('unpaid');
  });

  it('400 when the gateway says the payment belongs to a different order, or failed', async () => {
    const { student, bookingId, order, pay } = await withOrder();
    razorpay.payments.fetch.mockResolvedValue(gatewayPayment('order_someone_else', pay));
    expect((await verify(student, bookingId, order, pay)).body.code).toBe('ORDER_MISMATCH');
    razorpay.payments.fetch.mockResolvedValue(gatewayPayment(order, pay, { status: 'failed' }));
    expect((await verify(student, bookingId, order, pay)).body.code).toBe('PAYMENT_FAILED');
    expect((await bookingOf(bookingId)).payment_status).toBe('unpaid');
  });

  it('409 and NOT paid when the captured amount differs from what we ordered', async () => {
    const { student, bookingId, order, pay } = await withOrder();
    razorpay.payments.fetch.mockResolvedValue(gatewayPayment(order, pay, { amount: 100 }));
    const res = await verify(student, bookingId, order, pay);
    expect(res.status).toBe(409);
    expect((await bookingOf(bookingId)).payment_status).toBe('unpaid');
    const [row] = await paymentsOf(bookingId);
    expect(row.status).toBe('created');
    expect(row.failure_reason).toMatch(/amount_mismatch/);
  });
});

// =====================================================================
describe('POST /api/payments/webhook', () => {
  async function withOrder() {
    const ctx = await acceptedBooking();
    const order = (await createOrder(ctx.student, ctx.bookingId)).body.order_id;
    return { ...ctx, order, pay: `pay_${next()}` };
  }

  it('503 when no webhook secret is configured', async () => {
    const saved = process.env.RAZORPAY_WEBHOOK_SECRET;
    process.env.RAZORPAY_WEBHOOK_SECRET = '';
    try {
      const res = await webhook(capturedEvent('order_x', 'pay_x'));
      expect(res.status).toBe(503);
    } finally {
      process.env.RAZORPAY_WEBHOOK_SECRET = saved;
    }
  });

  it('400 for a wrong secret and for a body that was altered after signing', async () => {
    const { bookingId, order, pay } = await withOrder();
    expect((await webhook(capturedEvent(order, pay), { secret: 'wrong_secret' })).status).toBe(400);
    const signedFor = JSON.stringify(capturedEvent(order, pay, { amount: 1 }));
    expect((await webhook(capturedEvent(order, pay), { signBody: signedFor })).status).toBe(400);
    expect((await bookingOf(bookingId)).payment_status).toBe('unpaid');
  });

  it('a valid payment.captured marks the booking paid and notifies the teacher once', async () => {
    const { teacher, bookingId, order, pay } = await withOrder();
    const res = await webhook(capturedEvent(order, pay));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ received: true, duplicate: false });
    expect((await bookingOf(bookingId)).payment_status).toBe('paid');
    await drain();
    expect(await notificationCount(teacher.userId)).toBe(1);
  });

  it('a re-delivered event id is ignored (no second row, no second notification)', async () => {
    const { teacher, bookingId, order, pay } = await withOrder();
    const id = `evt_${next()}`;
    await webhook(capturedEvent(order, pay), { id });
    const again = await webhook(capturedEvent(order, pay), { id });
    expect(again.status).toBe(200);
    expect(again.body.duplicate).toBe(true);
    await drain();
    expect((await paymentsOf(bookingId)).filter((p) => p.status === 'paid')).toHaveLength(1);
    expect(await notificationCount(teacher.userId)).toBe(1);
    const [[{ n }]] = await db.query('SELECT COUNT(*) AS n FROM payment_events WHERE event_id = ?', [id]);
    expect(n).toBe(1);
  });

  it('payment.captured and order.paid for the same payment (different event ids) settle exactly once', async () => {
    const { teacher, bookingId, order, pay } = await withOrder();
    await webhook(capturedEvent(order, pay, {}, 'payment.captured'));
    await webhook(capturedEvent(order, pay, {}, 'order.paid'));
    await drain();
    expect((await paymentsOf(bookingId)).filter((p) => p.status === 'paid')).toHaveLength(1);
    expect(await notificationCount(teacher.userId)).toBe(1);
  });

  it('the checkout callback and the webhook racing each other settle exactly once', async () => {
    const { student, teacher, bookingId, order, pay } = await withOrder();
    razorpay.payments.fetch.mockResolvedValue(gatewayPayment(order, pay));
    const [v, w] = await Promise.all([verify(student, bookingId, order, pay), webhook(capturedEvent(order, pay))]);
    expect([v.status, w.status]).toEqual([200, 200]);
    await drain();
    expect((await paymentsOf(bookingId)).filter((p) => p.status === 'paid')).toHaveLength(1);
    expect((await bookingOf(bookingId)).payment_status).toBe('paid');
    expect(await notificationCount(teacher.userId)).toBe(1);
    expect(razorpay.payments.refund).not.toHaveBeenCalled();
  });

  it('200 and no changes for an order we never created', async () => {
    const res = await webhook(capturedEvent('order_unknown', 'pay_unknown'));
    expect(res.status).toBe(200);
  });

  it('a captured amount that differs from the order is NOT treated as paid', async () => {
    const { bookingId, order, pay } = await withOrder();
    await webhook(capturedEvent(order, pay, { amount: 100 }));
    expect((await bookingOf(bookingId)).payment_status).toBe('unpaid');
    expect((await paymentsOf(bookingId))[0].failure_reason).toMatch(/amount_mismatch/);
  });

  it('payment.failed only records the reason; the student can still pay on the same order', async () => {
    const { bookingId, order, pay } = await withOrder();
    await webhook({ event: 'payment.failed', payload: { payment: { entity: { id: pay, order_id: order, error_description: 'Card declined' } } } });
    const [row] = await paymentsOf(bookingId);
    expect(row).toMatchObject({ status: 'created', failure_reason: 'Card declined' });
    await webhook(capturedEvent(order, `pay_${next()}`));
    expect((await bookingOf(bookingId)).payment_status).toBe('paid');
  });

  it('a processing failure returns 500 and is NOT recorded, so the retry is processed', async () => {
    const { bookingId, order, pay } = await withOrder();
    const id = `evt_${next()}`;
    await db.query('RENAME TABLE payments TO payments_tmp');
    try {
      const failed = await webhook(capturedEvent(order, pay), { id });
      expect(failed.status).toBe(500);
    } finally {
      await db.query('RENAME TABLE payments_tmp TO payments');
    }
    const [[{ n }]] = await db.query('SELECT COUNT(*) AS n FROM payment_events WHERE event_id = ?', [id]);
    expect(n).toBe(0);
    const retry = await webhook(capturedEvent(order, pay), { id });
    expect(retry.status).toBe(200);
    expect(retry.body.duplicate).toBe(false);
    expect((await bookingOf(bookingId)).payment_status).toBe('paid');
  });

  it('a second payment for an already-settled booking is flagged duplicate and refunded automatically', async () => {
    const { student, teacher, bookingId, order, pay } = await withOrder();
    // The teacher records cash for the same class, then the student's online payment also lands.
    await request(app).put(`/api/bookings/${bookingId}/payment`).set(auth(teacher.token)).send({ payment_status: 'paid' }).expect(200);
    await webhook(capturedEvent(order, pay));
    await drain();
    const rows = await paymentsOf(bookingId);
    const online = rows.find((p) => p.method === 'razorpay');
    expect(online.status).toBe('refunded');
    expect(razorpay.payments.refund).toHaveBeenCalledWith(pay, expect.objectContaining({ amount: 35050 }));
    expect((await bookingOf(bookingId)).payment_status).toBe('paid'); // the cash payment still stands
    expect(student).toBeTruthy();
  });

  it('money that arrives after the class was cancelled is refunded automatically', async () => {
    const { student, bookingId, order, pay } = await withOrder();
    await request(app).put(`/api/bookings/${bookingId}/cancel`).set(auth(student.token)).expect(200);
    await webhook(capturedEvent(order, pay));
    await drain();
    expect(razorpay.payments.refund).toHaveBeenCalledWith(pay, expect.objectContaining({ amount: 35050 }));
    expect((await paymentsOf(bookingId))[0].status).toBe('refunded');
    expect((await bookingOf(bookingId)).payment_status).toBe('refunded');
  });

  it('refund.processed from the gateway marks the payment and booking refunded', async () => {
    const { bookingId, order, pay } = await withOrder();
    await webhook(capturedEvent(order, pay));
    await webhook({ event: 'refund.processed', payload: { refund: { entity: { id: 'rfnd_dash', payment_id: pay, amount: 35050 } } } });
    expect((await paymentsOf(bookingId))[0]).toMatchObject({ status: 'refunded', razorpay_refund_id: 'rfnd_dash' });
    expect((await bookingOf(bookingId)).payment_status).toBe('refunded');
  });

  it('a partial refund seen at the gateway does not flip our records', async () => {
    const { bookingId, order, pay } = await withOrder();
    await webhook(capturedEvent(order, pay));
    await webhook({ event: 'refund.processed', payload: { refund: { entity: { id: 'rfnd_part', payment_id: pay, amount: 100 } } } });
    expect((await paymentsOf(bookingId))[0].status).toBe('paid');
    expect((await bookingOf(bookingId)).payment_status).toBe('paid');
  });
});

// =====================================================================
describe('PUT /api/bookings/:id/payment — cash payments only', () => {
  const put = (id, token, status) => request(app).put(`/api/bookings/${id}/payment`).set(auth(token)).send({ payment_status: status });

  it('403 for students and for a different teacher; 400 for an invalid value', async () => {
    const { student, bookingId, teacher } = await acceptedBooking();
    const other = await createTeacher();
    expect((await put(bookingId, student.token, 'paid')).status).toBe(403);
    expect((await put(bookingId, other.token, 'paid')).status).toBe(403);
    expect((await put(bookingId, teacher.token, 'free-money')).status).toBe(400);
    expect((await bookingOf(bookingId)).payment_status).toBe('unpaid');
  });

  it('records cash once, with a ledger row for the exact fee', async () => {
    const { teacher, bookingId } = await acceptedBooking({ fee: 200 });
    expect((await put(bookingId, teacher.token, 'paid')).status).toBe(200);
    expect((await bookingOf(bookingId)).payment_status).toBe('paid');
    expect(await paymentsOf(bookingId)).toEqual([expect.objectContaining({ method: 'offline', status: 'paid', amount_paise: 20000 })]);
    const again = await put(bookingId, teacher.token, 'paid');
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('ALREADY_PAID');
    expect(await paymentsOf(bookingId)).toHaveLength(1);
  });

  it('simultaneous "mark paid" clicks create a single payment', async () => {
    const { teacher, bookingId } = await acceptedBooking();
    const results = await Promise.all(Array.from({ length: 5 }, () => put(bookingId, teacher.token, 'paid')));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(await paymentsOf(bookingId)).toHaveLength(1);
  });

  it('refuses to mark a request, or a free class, as paid', async () => {
    const student = await createStudent();
    const teacher = await createTeacher();
    const requested = await insertBooking({ studentId: student.studentId, teacherId: teacher.teacherId, status: 'requested', date: futureDate(4), fee: 100 });
    expect((await put(requested, teacher.token, 'paid')).body.code).toBe('BOOKING_NOT_ACCEPTED');
    const free = await insertBooking({ studentId: student.studentId, teacherId: teacher.teacherId, status: 'accepted', date: futureDate(5), fee: 0 });
    expect((await put(free, teacher.token, 'paid')).body.code).toBe('NO_FEE');
  });

  it('can undo or refund its own cash record, then record it again', async () => {
    const { teacher, bookingId } = await acceptedBooking();
    await put(bookingId, teacher.token, 'paid');
    expect((await put(bookingId, teacher.token, 'unpaid')).status).toBe(200);
    expect((await bookingOf(bookingId)).payment_status).toBe('unpaid');
    expect((await put(bookingId, teacher.token, 'paid')).status).toBe(200);
    expect((await put(bookingId, teacher.token, 'refunded')).status).toBe(200);
    expect((await bookingOf(bookingId)).payment_status).toBe('refunded');
    const methods = (await paymentsOf(bookingId)).map((p) => `${p.method}:${p.status}`);
    expect(methods).toEqual(['offline:void', 'offline:refunded']);
  });

  it('cannot undo, refund or double-record a payment that went through Razorpay', async () => {
    const { teacher, bookingId } = await paidOnline();
    for (const target of ['unpaid', 'refunded']) {
      const res = await put(bookingId, teacher.token, target);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('ONLINE_PAYMENT_LOCKED');
    }
    expect((await put(bookingId, teacher.token, 'paid')).body.code).toBe('ALREADY_PAID');
    expect((await bookingOf(bookingId)).payment_status).toBe('paid');
    expect((await paymentsOf(bookingId))[0].status).toBe('paid');
  });
});

// =====================================================================
describe('refunds when a paid class is cancelled', () => {
  const cancelAsTeacher = (id, t) => request(app).put(`/api/bookings/${id}/status`).set(auth(t.token)).send({ status: 'cancelled' });
  const cancelAsStudent = (id, s) => request(app).put(`/api/bookings/${id}/cancel`).set(auth(s.token));

  it('teacher cancellation: full refund at the gateway, ledger and booking updated', async () => {
    const { teacher, bookingId, paymentRowId } = await paidOnline({ fee: 500 });
    const res = await cancelAsTeacher(bookingId, teacher);
    expect(res.status).toBe(200);
    expect(res.body.refund).toBe('initiated');
    await drain();
    const [[p]] = await db.query('SELECT * FROM payments WHERE id = ?', [paymentRowId]);
    expect(razorpay.payments.refund).toHaveBeenCalledWith(p.razorpay_payment_id, expect.objectContaining({ amount: 50000 }));
    expect(p.status).toBe('refunded');
    expect(p.razorpay_refund_id).toMatch(/^rfnd_/);
    expect((await bookingOf(bookingId)).payment_status).toBe('refunded');
  });

  it('student cancelling well before the class is refunded', async () => {
    const { student, bookingId } = await paidOnline({ date: futureDate(10) });
    const res = await cancelAsStudent(bookingId, student);
    expect(res.body.refund).toBe('initiated');
    await drain();
    expect((await bookingOf(bookingId)).payment_status).toBe('refunded');
  });

  it('student cancelling inside the refund window is not refunded automatically, but a teacher cancel still is', async () => {
    const { student, teacher, bookingId, paymentRowId } = await paidOnline({ date: futureDate(0), time: '11:59 PM' });
    const res = await cancelAsStudent(bookingId, student);
    expect(res.status).toBe(200);
    expect(res.body.refund).toBe('not_eligible');
    expect(res.body.message).toMatch(/not refunded automatically/);
    await drain();
    expect(razorpay.payments.refund).not.toHaveBeenCalled();
    expect((await db.query('SELECT status FROM payments WHERE id = ?', [paymentRowId]))[0][0].status).toBe('paid');
    // an admin can still decide to refund it
    const admin = await createAdmin();
    const forced = await request(app).post(`/api/admin/payments/${paymentRowId}/refund`).set(auth(admin.token));
    expect(forced.status).toBe(200);
    expect(teacher).toBeTruthy();
  });

  it('if the gateway refuses, the refund stays pending (never lost) and an admin can retry it', async () => {
    razorpay.payments.refund.mockRejectedValueOnce({ error: { description: 'Gateway is down' } });
    const { teacher, bookingId, paymentRowId } = await paidOnline();
    await cancelAsTeacher(bookingId, teacher);
    await drain();
    let [[p]] = await db.query('SELECT status, failure_reason FROM payments WHERE id = ?', [paymentRowId]);
    expect(p.status).toBe('refund_pending');
    expect(p.failure_reason).toMatch(/Gateway is down/);
    expect((await bookingOf(bookingId)).payment_status).toBe('paid');

    const admin = await createAdmin();
    const retry = await request(app).post(`/api/admin/payments/${paymentRowId}/refund`).set(auth(admin.token));
    expect(retry.status).toBe(200);
    [[p]] = await db.query('SELECT status, failure_reason FROM payments WHERE id = ?', [paymentRowId]);
    expect(p).toMatchObject({ status: 'refunded', failure_reason: null });
    expect((await bookingOf(bookingId)).payment_status).toBe('refunded');
  });

  it('a class paid in cash is never refunded through the gateway', async () => {
    const { student, teacher, bookingId } = await acceptedBooking({ fee: 100 });
    await request(app).put(`/api/bookings/${bookingId}/payment`).set(auth(teacher.token)).send({ payment_status: 'paid' }).expect(200);
    const res = await cancelAsStudent(bookingId, student);
    expect(res.body.refund).toBe('manual');
    await drain();
    expect(razorpay.payments.refund).not.toHaveBeenCalled();
  });

  it('cancelling an unpaid class involves no refund', async () => {
    const { student, bookingId } = await acceptedBooking();
    expect((await cancelAsStudent(bookingId, student)).body.refund).toBe('none');
  });

  it('two simultaneous cancellations refund the money exactly once', async () => {
    const { student, teacher, bookingId } = await paidOnline({ date: futureDate(12) });
    await Promise.all([cancelAsStudent(bookingId, student), cancelAsTeacher(bookingId, teacher)]);
    await drain();
    expect(razorpay.payments.refund).toHaveBeenCalledTimes(1);
    expect((await bookingOf(bookingId)).payment_status).toBe('refunded');
  });
});

// =====================================================================
describe('admin payment endpoints', () => {
  it('are admin-only', async () => {
    const student = await createStudent();
    const teacher = await createTeacher();
    for (const who of [student, teacher]) {
      expect((await request(app).get('/api/admin/payments').set(auth(who.token))).status).toBe(403);
      expect((await request(app).post('/api/admin/payments/1/refund').set(auth(who.token))).status).toBe(403);
    }
    expect((await request(app).get('/api/admin/payments')).status).toBe(401);
  });

  it('lists payments, validates the status filter, and never exposes secrets', async () => {
    const admin = await createAdmin();
    await paidOnline();
    const res = await request(app).get('/api/admin/payments?status=paid').set(auth(admin.token));
    expect(res.status).toBe(200);
    expect(res.body.payments.length).toBeGreaterThan(0);
    expect(res.body.payments.every((p) => p.status === 'paid')).toBe(true);
    expect(JSON.stringify(res.body)).not.toMatch(/secret|password/i);
    expect((await request(app).get('/api/admin/payments?status=bogus').set(auth(admin.token))).status).toBe(400);
  });

  it('refund: 404 unknown, 409 for cash and for already-refunded, 200 for an online payment', async () => {
    const admin = await createAdmin();
    const post = (id) => request(app).post(`/api/admin/payments/${id}/refund`).set(auth(admin.token));
    expect((await post(99999999)).status).toBe(404);
    expect((await post('abc')).status).toBe(400);

    const cash = await acceptedBooking();
    const cashId = await insertPayment({ bookingId: cash.bookingId, method: 'offline', status: 'paid', amountPaise: 100 });
    expect((await post(cashId)).body.code).toBe('MANUAL_PAYMENT');

    const online = await paidOnline();
    expect((await post(online.paymentRowId)).status).toBe(200);
    expect((await post(online.paymentRowId)).body.code).toBe('INVALID_STATE');
  });

  it('two admins clicking refund at once refund the money once', async () => {
    const admin = await createAdmin();
    const { paymentRowId } = await paidOnline();
    const post = () => request(app).post(`/api/admin/payments/${paymentRowId}/refund`).set(auth(admin.token));
    const results = await Promise.all([post(), post(), post()]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(2);
    expect(razorpay.payments.refund).toHaveBeenCalledTimes(1);
  });
});

// =====================================================================
describe('ledger integrity', () => {
  it('the database allows only one active payment per booking, even if the app logic were bypassed', async () => {
    const { bookingId } = await acceptedBooking();
    await insertPayment({ bookingId, method: 'offline', status: 'paid' });
    await expect(insertPayment({ bookingId, method: 'razorpay', status: 'paid' })).rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });
    // refunded / void / duplicate rows do not count as active
    await insertPayment({ bookingId, method: 'razorpay', status: 'refunded' });
    await insertPayment({ bookingId, method: 'offline', status: 'void' });
  });

  it('a Razorpay payment id can be recorded only once', async () => {
    const a = await acceptedBooking();
    const b = await acceptedBooking();
    await insertPayment({ bookingId: a.bookingId, paymentId: 'pay_unique_once' });
    await expect(insertPayment({ bookingId: b.bookingId, paymentId: 'pay_unique_once' })).rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });
  });

  it('GET /api/payments/booking/:id is limited to the two people on the booking', async () => {
    const { student, teacher, bookingId } = await acceptedBooking();
    const stranger = await createStudent();
    expect((await request(app).get(`/api/payments/booking/${bookingId}`).set(auth(student.token))).body.payment_status).toBe('unpaid');
    expect((await request(app).get(`/api/payments/booking/${bookingId}`).set(auth(teacher.token))).status).toBe(200);
    expect((await request(app).get(`/api/payments/booking/${bookingId}`).set(auth(stranger.token))).status).toBe(403);
  });
});