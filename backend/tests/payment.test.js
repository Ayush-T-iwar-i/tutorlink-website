const request = require('supertest');
const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

jest.mock('../config/db', () => ({ query: jest.fn() }));
jest.mock('../config/email', () => ({ sendMail: jest.fn().mockResolvedValue() }));
jest.mock('./notification.routes', () => ({ createNotification: jest.fn().mockResolvedValue() }), { virtual: true });

const db = require('../config/db');
process.env.JWT_SECRET = 'test_secret';
process.env.RAZORPAY_KEY_ID = 'rzp_test_key123';
process.env.RAZORPAY_KEY_SECRET = 'rzp_test_secret456';

const paymentRoutes = require('../routes/payment.routes');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/payments', paymentRoutes);
  return app;
}

function studentToken(userId = 5) {
  return jwt.sign({ id: userId, role: 'student' }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

describe('POST /api/payments/verify', () => {
  let app;
  beforeEach(() => {
    app = buildApp();
    jest.clearAllMocks();
  });

  it('rejects verification if missing payment details', async () => {
    const res = await request(app)
      .post('/api/payments/verify')
      .set('Authorization', `Bearer ${studentToken(5)}`)
      .send({ booking_id: 1 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/missing payment details/i);
  });

  it('rejects payment with forged or invalid HMAC signature', async () => {
    const res = await request(app)
      .post('/api/payments/verify')
      .set('Authorization', `Bearer ${studentToken(5)}`)
      .send({
        booking_id: 1,
        razorpay_order_id: 'order_123',
        razorpay_payment_id: 'pay_456',
        razorpay_signature: 'fake_signature_hex_value_1234567890abcdef',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/verification failed/i);
  });

  it('successfully verifies payment with genuine HMAC signature', async () => {
    const orderId = 'order_123';
    const paymentId = 'pay_456';
    const genuineSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${orderId}|${paymentId}`)
      .digest('hex');

    db.query
      .mockResolvedValueOnce([[{ id: 1, fee: 400 }]]) // booking ownership check
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // update status to paid
      .mockResolvedValueOnce([[{ user_id: 10, name: 'Teacher', email: 'teacher@example.com' }]]); // teacher notification lookup

    const res = await request(app)
      .post('/api/payments/verify')
      .set('Authorization', `Bearer ${studentToken(5)}`)
      .send({
        booking_id: 1,
        razorpay_order_id: orderId,
        razorpay_payment_id: paymentId,
        razorpay_signature: genuineSignature,
      });

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/verified successfully/i);
  });
});
