const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');

jest.mock('../config/db', () => ({ query: jest.fn() }));
jest.mock('../lib/push', () => ({ sendPushToUser: jest.fn().mockResolvedValue() }));

const db = require('../config/db');
process.env.JWT_SECRET = 'test_secret';
const notificationRoutes = require('../routes/notification.routes');

const app = express();
app.use(express.json());
app.use('/api/notifications', notificationRoutes);
const auth = () => `Bearer ${jwt.sign({ id: 5, role: 'student' }, process.env.JWT_SECRET, { expiresIn: '1h' })}`;

beforeEach(() => db.query.mockReset());

describe('DELETE /api/notifications/:id', () => {
  test('requires login', async () => {
    expect((await request(app).delete('/api/notifications/3')).status).toBe(401);
  });

  test('rejects an invalid id without touching the database', async () => {
    const res = await request(app).delete('/api/notifications/abc').set('Authorization', auth());
    expect(res.status).toBe(400);
    expect(db.query).not.toHaveBeenCalled();
  });

  test('deletes only the caller\'s own notification', async () => {
    db.query.mockResolvedValueOnce([{ affectedRows: 1 }]);
    const res = await request(app).delete('/api/notifications/3').set('Authorization', auth());
    expect(res.status).toBe(200);
    expect(db.query.mock.calls[0][0]).toContain('user_id = ?');
    expect(db.query.mock.calls[0][1]).toEqual([3, 5]);
  });
});

describe('DELETE /api/notifications (clear all)', () => {
  test('clears everything for the logged-in user only', async () => {
    db.query.mockResolvedValueOnce([{ affectedRows: 4 }]);
    const res = await request(app).delete('/api/notifications').set('Authorization', auth());
    expect(res.status).toBe(200);
    expect(db.query.mock.calls[0][1]).toEqual([5]);
  });

  test('requires login', async () => {
    expect((await request(app).delete('/api/notifications')).status).toBe(401);
  });
});