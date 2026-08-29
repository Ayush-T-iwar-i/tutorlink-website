const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');

jest.mock('../config/db', () => ({ query: jest.fn() }));
jest.mock('../config/email', () => ({ sendMail: jest.fn().mockResolvedValue() }));
jest.mock('../config/sms', () => ({ sendSms: jest.fn().mockResolvedValue() }));

const db = require('../config/db');
process.env.JWT_SECRET = 'test_secret';
const teacherRoutes = require('../routes/teacher.routes');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/teachers', teacherRoutes);
  return app;
}

function teacherToken(userId = 10) {
  return jwt.sign({ id: userId, role: 'teacher' }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

function studentToken(userId = 5) {
  return jwt.sign({ id: userId, role: 'student' }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

describe('GET /api/teachers/browse', () => {
  let app;
  beforeEach(() => {
    app = buildApp();
    jest.clearAllMocks();
  });

  it('fetches approved teachers with pagination and sorting', async () => {
    const mockTeachers = [
      { id: 1, name: 'Ananya Sharma', subjects: 'Mathematics', fee_per_hour: 500, rating_avg: 4.8, total_reviews: 12, city: 'Gurugram' }
    ];
    db.query
      .mockResolvedValueOnce([mockTeachers]) // rows query
      .mockResolvedValueOnce([[{ total: 1 }]]); // count query

    const res = await request(app).get('/api/teachers/browse?sort=rating&page=1&limit=12');

    expect(res.status).toBe(200);
    expect(res.body.teachers).toHaveLength(1);
    expect(res.body.total).toBe(1);
    expect(res.body.teachers[0].name).toBe('Ananya Sharma');
  });

  it('filters teachers by subject and city', async () => {
    db.query
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[{ total: 0 }]]);

    const res = await request(app).get('/api/teachers/browse?subject=Physics&city=Delhi');

    expect(res.status).toBe(200);
    expect(res.body.teachers).toEqual([]);
    expect(res.body.total).toBe(0);
  });
});

describe('GET /api/teachers/nearby', () => {
  let app;
  beforeEach(() => {
    app = buildApp();
    jest.clearAllMocks();
  });

  it('rejects nearby search when lat or lng is missing', async () => {
    const res = await request(app).get('/api/teachers/nearby?radius=5');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/lat and lng/i);
  });

  it('returns distance-matched teachers within radius', async () => {
    const mockNearby = [
      { id: 2, name: 'Rahul Verma', subjects: 'Chemistry', distance_km: 2.3, rating_avg: 5.0, total_reviews: 4 }
    ];
    db.query
      .mockResolvedValueOnce([[{ total: 1 }]])
      .mockResolvedValueOnce([mockNearby]);

    const res = await request(app).get('/api/teachers/nearby?lat=28.4595&lng=77.0266&radius=5');

    expect(res.status).toBe(200);
    expect(res.body.teachers).toHaveLength(1);
    expect(res.body.teachers[0].distance_km).toBe(2.3);
  });
});

describe('PUT /api/teachers/:userId/profile', () => {
  let app;
  beforeEach(() => {
    app = buildApp();
    jest.clearAllMocks();
  });

  it('allows teacher to update their own profile', async () => {
    db.query.mockResolvedValueOnce([{ affectedRows: 1 }]);

    const res = await request(app)
      .put('/api/teachers/10/profile')
      .set('Authorization', `Bearer ${teacherToken(10)}`)
      .send({
        qualification: 'M.Sc Physics',
        subjects: 'Physics, Maths',
        experience_years: 6,
        fee_per_hour: 450,
      });

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/updated successfully/i);
  });

  it('blocks student from updating teacher profile', async () => {
    const res = await request(app)
      .put('/api/teachers/10/profile')
      .set('Authorization', `Bearer ${studentToken(5)}`)
      .send({ qualification: 'M.Sc' });

    expect(res.status).toBe(403);
  });

  it('blocks teacher from updating another teacher profile (IDOR prevention)', async () => {
    const res = await request(app)
      .put('/api/teachers/99/profile')
      .set('Authorization', `Bearer ${teacherToken(10)}`)
      .send({ qualification: 'M.Sc' });

    expect(res.status).toBe(403);
  });
});
