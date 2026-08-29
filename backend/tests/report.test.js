const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');

jest.mock('../config/db', () => ({ query: jest.fn() }));

const db = require('../config/db');
process.env.JWT_SECRET = 'test_secret';
const reportRoutes = require('../routes/report.routes');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/reports', reportRoutes);
  return app;
}

function userToken(userId = 5, role = 'student') {
  return jwt.sign({ id: userId, role }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

describe('POST /api/reports', () => {
  let app;
  beforeEach(() => {
    app = buildApp();
    jest.clearAllMocks();
  });

  it('rejects report if reported user is missing', async () => {
    const res = await request(app)
      .post('/api/reports')
      .set('Authorization', `Bearer ${userToken(5)}`)
      .send({ reason: 'no_show' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/reported_user_id/i);
  });

  it('rejects report if reason is invalid', async () => {
    const res = await request(app)
      .post('/api/reports')
      .set('Authorization', `Bearer ${userToken(5)}`)
      .send({ reported_user_id: 10, reason: 'random_invalid_reason' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/reason must be one of/i);
  });

  it('prevents user from reporting themselves', async () => {
    const res = await request(app)
      .post('/api/reports')
      .set('Authorization', `Bearer ${userToken(5)}`)
      .send({ reported_user_id: 5, reason: 'other' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cannot report yourself/i);
  });

  it('files report successfully when valid', async () => {
    db.query.mockResolvedValueOnce([{ insertId: 1 }]);

    const res = await request(app)
      .post('/api/reports')
      .set('Authorization', `Bearer ${userToken(5)}`)
      .send({
        reported_user_id: 10,
        reason: 'no_show',
        details: 'Teacher did not show up at the scheduled time.',
      });

    expect(res.status).toBe(201);
    expect(res.body.message).toMatch(/report submitted/i);
  });
});
