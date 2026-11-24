const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');

jest.mock('../config/db', () => ({ query: jest.fn() }));
jest.mock('../config/email', () => ({ sendMail: jest.fn().mockResolvedValue() }));
jest.mock('../config/sms', () => ({ sendSms: jest.fn().mockResolvedValue() }));

const db = require('../config/db');
process.env.JWT_SECRET = 'test_secret';
const bookingRoutes = require('../routes/booking.routes');
const rules = require('../lib/booking-rules');

const app = express();
app.use(express.json());
app.use('/api/bookings', bookingRoutes);

const tokenFor = (role, id = 5) => jwt.sign({ id, role }, process.env.JWT_SECRET, { expiresIn: '1h' });
const student = () => `Bearer ${tokenFor('student', 5)}`;
const teacher = () => `Bearer ${tokenFor('teacher', 9)}`;

beforeEach(() => {
  db.query.mockReset();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => console.error.mockRestore());

describe('PUT /api/bookings/:id/demo-decision', () => {
  const put = (body, auth = student()) =>
    request(app).put('/api/bookings/7/demo-decision').set('Authorization', auth).send(body);

  test('rejects anything except continue / declined', async () => {
    const res = await put({ decision: 'maybe' });
    expect(res.status).toBe(400);
    expect(db.query).not.toHaveBeenCalled();
  });

  test('teachers cannot use it', async () => {
    const res = await put({ decision: 'continue' }, teacher());
    expect(res.status).toBe(403);
  });

  test('404 when the booking is not the student\'s', async () => {
    db.query.mockResolvedValueOnce([[]]);
    const res = await put({ decision: 'declined' });
    expect(res.status).toBe(404);
  });

  test('409 while the demo class has not taken place yet', async () => {
    db.query.mockResolvedValueOnce([[{ id: 7, type: 'demo', status: 'accepted', booking_date: '2099-01-01', booking_time: '5:00 PM' }]]);
    const res = await put({ decision: 'declined' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DEMO_NOT_HELD');
  });

  test('409 for a booking that is not a demo', async () => {
    db.query.mockResolvedValueOnce([[{ id: 7, type: 'recurring', status: 'completed', booking_date: '2020-01-01', booking_time: '5:00 PM' }]]);
    const res = await put({ decision: 'declined' });
    expect(res.status).toBe(409);
  });

  test('saves the decision for a completed demo', async () => {
    db.query
      .mockResolvedValueOnce([[{ id: 7, type: 'demo', status: 'completed', booking_date: '2020-01-01', booking_time: '5:00 PM' }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);
    const res = await put({ decision: 'declined' });
    expect(res.status).toBe(200);
    expect(db.query.mock.calls[1][0]).toContain('UPDATE bookings SET demo_decision');
    expect(db.query.mock.calls[1][1]).toEqual(['declined', 7]);
  });
});

describe('POST /api/bookings/:id/plan-request', () => {
  const post = (body, auth = student()) =>
    request(app).post('/api/bookings/7/plan-request').set('Authorization', auth).send(body);
  const runningPlan = (over) => ({
    id: 7, type: 'recurring', status: 'accepted', subject: 'Maths',
    booking_date: rules.todayInTz(), duration_months: 1, plan_request: null,
    teacher_user_id: 9, student_name: 'Riya', ...over,
  });

  test('rejects an unknown request type', async () => {
    const res = await post({ request: 'delete' });
    expect(res.status).toBe(400);
  });

  test('teachers cannot send it', async () => {
    const res = await post({ request: 'pause' }, teacher());
    expect(res.status).toBe(403);
  });

  test('404 when it is not the student\'s booking', async () => {
    db.query.mockResolvedValueOnce([[]]);
    const res = await post({ request: 'pause' });
    expect(res.status).toBe(404);
  });

  test('409 when the plan is not running (demo class, or plan already ended)', async () => {
    db.query.mockResolvedValueOnce([[runningPlan({ type: 'demo' })]]);
    expect((await post({ request: 'pause' })).body.code).toBe('PLAN_NOT_ACTIVE');
    db.query.mockResolvedValueOnce([[runningPlan({ booking_date: '2020-01-01' })]]);
    expect((await post({ request: 'stop' })).status).toBe(409);
  });

  test('409 when a request is already waiting', async () => {
    db.query.mockResolvedValueOnce([[runningPlan()]]).mockResolvedValueOnce([{ affectedRows: 0 }]);
    const res = await post({ request: 'pause' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('REQUEST_PENDING');
  });

  test('stores a pause request for a running plan', async () => {
    db.query.mockResolvedValueOnce([[runningPlan()]]).mockResolvedValueOnce([{ affectedRows: 1 }]);
    const res = await post({ request: 'pause', note: '  exams  ' });
    expect(res.status).toBe(200);
    expect(db.query.mock.calls[1][1].slice(0, 3)).toEqual(['pause', 'exams', 7]);
  });
});

describe('DELETE /api/bookings/:id/plan-request', () => {
  test('404 when the booking does not belong to the caller', async () => {
    db.query.mockResolvedValueOnce([[]]);
    const res = await request(app).delete('/api/bookings/7/plan-request').set('Authorization', student());
    expect(res.status).toBe(404);
  });

  test('a teacher can mark a request as seen', async () => {
    db.query.mockResolvedValueOnce([[{ id: 7 }]]).mockResolvedValueOnce([{ affectedRows: 1 }]);
    const res = await request(app).delete('/api/bookings/7/plan-request').set('Authorization', teacher());
    expect(res.status).toBe(200);
    expect(db.query.mock.calls[0][0]).toContain('JOIN teachers');
  });

  test('a student withdrawing uses the students table', async () => {
    db.query.mockResolvedValueOnce([[{ id: 7 }]]).mockResolvedValueOnce([{ affectedRows: 1 }]);
    await request(app).delete('/api/bookings/7/plan-request').set('Authorization', student());
    expect(db.query.mock.calls[0][0]).toContain('JOIN students');
  });

  test('requires login', async () => {
    const res = await request(app).delete('/api/bookings/7/plan-request');
    expect(res.status).toBe(401);
  });
});