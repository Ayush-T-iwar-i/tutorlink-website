const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');

jest.mock('../config/db', () => ({ query: jest.fn() }));

const db = require('../config/db');
process.env.JWT_SECRET = 'test_secret';
const reviewRoutes = require('../routes/review.routes');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/reviews', reviewRoutes);
  return app;
}

function studentToken(userId = 5) {
  return jwt.sign({ id: userId, role: 'student' }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

function teacherToken(userId = 10) {
  return jwt.sign({ id: userId, role: 'teacher' }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

describe('POST /api/reviews', () => {
  let app;
  beforeEach(() => {
    app = buildApp();
    jest.clearAllMocks();
  });

  it('rejects review with invalid rating (must be 1-5)', async () => {
    const res = await request(app)
      .post('/api/reviews')
      .set('Authorization', `Bearer ${studentToken(5)}`)
      .send({ booking_id: 1, rating: 6 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/between 1 and 5/i);
  });

  it('rejects review on non-completed booking', async () => {
    db.query.mockResolvedValueOnce([[{ id: 1, teacher_id: 2, status: 'accepted' }]]);

    const res = await request(app)
      .post('/api/reviews')
      .set('Authorization', `Bearer ${studentToken(5)}`)
      .send({ booking_id: 1, rating: 5, comment: 'Great class!' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/marked completed/i);
  });

  it('rejects review on a booking not owned by student', async () => {
    db.query.mockResolvedValueOnce([[]]); // no matching booking for user

    const res = await request(app)
      .post('/api/reviews')
      .set('Authorization', `Bearer ${studentToken(5)}`)
      .send({ booking_id: 99, rating: 5 });

    expect(res.status).toBe(403);
  });

  it('creates review and updates teacher rating average', async () => {
    db.query
      .mockResolvedValueOnce([[{ id: 1, teacher_id: 2, status: 'completed' }]]) // booking ownership
      .mockResolvedValueOnce([[]]) // no existing review
      .mockResolvedValueOnce([{ insertId: 10 }]) // insert review
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // update teacher stats

    const res = await request(app)
      .post('/api/reviews')
      .set('Authorization', `Bearer ${studentToken(5)}`)
      .send({ booking_id: 1, rating: 5, comment: 'Excellent tutor!' });

    expect(res.status).toBe(201);
    expect(res.body.message).toMatch(/submitted/i);
  });
});

describe('PUT /api/reviews/:id/reply', () => {
  let app;
  beforeEach(() => {
    app = buildApp();
    jest.clearAllMocks();
  });

  it('allows teacher to reply to a review on their profile', async () => {
    db.query
      .mockResolvedValueOnce([[{ id: 10 }]]) // review belongs to teacher
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // update reply

    const res = await request(app)
      .put('/api/reviews/10/reply')
      .set('Authorization', `Bearer ${teacherToken(10)}`)
      .send({ reply: 'Thank you for the kind words!' });

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/reply posted/i);
  });

  it('blocks reply if not the teacher of the booking', async () => {
    db.query.mockResolvedValueOnce([[]]);

    const res = await request(app)
      .put('/api/reviews/10/reply')
      .set('Authorization', `Bearer ${teacherToken(99)}`)
      .send({ reply: 'Spam reply' });

    expect(res.status).toBe(403);
  });
});
