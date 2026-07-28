const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');

jest.mock('../config/db', () => ({ query: jest.fn() }));
jest.mock('../config/email', () => ({ sendMail: jest.fn().mockResolvedValue() }));
jest.mock('../config/sms', () => ({ sendSms: jest.fn().mockResolvedValue() }));
jest.mock('./notification.routes', () => ({ createNotification: jest.fn().mockResolvedValue() }), { virtual: true });

const db = require('../config/db');

process.env.JWT_SECRET = 'test_secret';
const bookingRoutes = require('../routes/booking.routes');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/bookings', bookingRoutes);
  return app;
}

function studentToken() {
  return jwt.sign({ id: 5, role: 'student' }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

function teacherToken() {
  return jwt.sign({ id: 9, role: 'teacher' }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

describe('POST /api/bookings', () => {
  let app;
  beforeEach(() => {
    app = buildApp();
    jest.clearAllMocks();
  });

  it('rejects a booking request with no teacher_id', async () => {
    const res = await request(app)
      .post('/api/bookings')
      .set('Authorization', `Bearer ${studentToken()}`)
      .send({ subject: 'Maths' });
    expect(res.status).toBe(400);
  });

  it('rejects requests from a teacher role (students only)', async () => {
    const res = await request(app)
      .post('/api/bookings')
      .set('Authorization', `Bearer ${teacherToken()}`)
      .send({ teacher_id: 1, subject: 'Maths' });
    expect(res.status).toBe(403);
  });

  it('rejects requests with no auth token at all', async () => {
    const res = await request(app).post('/api/bookings').send({ teacher_id: 1 });
    expect(res.status).toBe(401);
  });
});

describe('PUT /api/bookings/:id/status', () => {
  let app;
  beforeEach(() => {
    app = buildApp();
    jest.clearAllMocks();
  });

  it('rejects an invalid status value', async () => {
    const res = await request(app)
      .put('/api/bookings/1/status')
      .set('Authorization', `Bearer ${teacherToken()}`)
      .send({ status: 'not_a_real_status' });
    expect(res.status).toBe(400);
  });

  it('requires a fee when accepting a booking', async () => {
    const res = await request(app)
      .put('/api/bookings/1/status')
      .set('Authorization', `Bearer ${teacherToken()}`)
      .send({ status: 'accepted' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/fee/i);
  });

  it('blocks a teacher from updating a booking that is not theirs', async () => {
    db.query.mockResolvedValueOnce([[]]); // ownership check finds nothing
    const res = await request(app)
      .put('/api/bookings/1/status')
      .set('Authorization', `Bearer ${teacherToken()}`)
      .send({ status: 'accepted', fee: 300 });
    expect(res.status).toBe(403);
  });
});