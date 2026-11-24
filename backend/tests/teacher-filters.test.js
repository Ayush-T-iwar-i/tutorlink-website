const request = require('supertest');
const express = require('express');

jest.mock('../config/db', () => ({ query: jest.fn() }));
jest.mock('../config/email', () => ({ sendMail: jest.fn().mockResolvedValue() }));
jest.mock('../config/sms', () => ({ sendSms: jest.fn().mockResolvedValue() }));

const db = require('../config/db');
const teacherRoutes = require('../routes/teacher.routes');

const app = express();
app.use(express.json());
app.use('/api/teachers', teacherRoutes);

beforeEach(() => {
  db.query.mockReset();
  db.query.mockResolvedValueOnce([[]]).mockResolvedValueOnce([[{ total: 0 }]]);
});

describe('GET /api/teachers/browse filters', () => {
  test('applies fee, rating, experience and class filters', async () => {
    const res = await request(app).get('/api/teachers/browse?max_fee=500&min_rating=4&min_exp=5&grade=10');
    expect(res.status).toBe(200);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toContain('t.fee_per_hour <= ?');
    expect(sql).toContain('t.rating_avg >= ?');
    expect(sql).toContain('t.experience_years >= ?');
    expect(sql).toContain('t.grades LIKE ?');
    expect(params).toEqual([500, 4, 5, '%10%', 12, 0]);
  });

  test('ignores invalid or empty filter values', async () => {
    const res = await request(app).get('/api/teachers/browse?max_fee=abc&min_rating=-1&min_exp=0&grade=');
    expect(res.status).toBe(200);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).not.toContain('t.fee_per_hour <= ?');
    expect(sql).not.toContain('t.rating_avg >= ?');
    expect(sql).not.toContain('t.experience_years >= ?');
    expect(params).toEqual([12, 0]);
  });

  test('caps out-of-range values', async () => {
    await request(app).get('/api/teachers/browse?min_rating=99&min_exp=500');
    expect(db.query.mock.calls[0][1]).toEqual([5, 60, 12, 0]);
  });

  test('"popular" sorts by students on plans', async () => {
    await request(app).get('/api/teachers/browse?sort=popular');
    expect(db.query.mock.calls[0][0]).toContain('ORDER BY plan_students DESC');
  });

  test('an unknown sort falls back to rating', async () => {
    await request(app).get('/api/teachers/browse?sort=hacked;DROP');
    expect(db.query.mock.calls[0][0]).toContain('ORDER BY t.rating_avg DESC');
  });
});