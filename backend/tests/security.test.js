const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');

jest.mock('../config/db', () => ({ query: jest.fn() }));
const db = require('../config/db');

process.env.JWT_SECRET = 'test_secret';

const authRoutes = require('../routes/auth.routes');
const teacherRoutes = require('../routes/teacher.routes');
const studentRoutes = require('../routes/student.routes');
const messageRoutes = require('../routes/message.routes');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  app.use('/api/teachers', teacherRoutes);
  app.use('/api/students', studentRoutes);
  app.use('/api/messages', messageRoutes);
  return app;
}

function userToken(userId, role) {
  return jwt.sign({ id: userId, role }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

describe('Security & IDOR Audit Tests', () => {
  let app;
  beforeEach(() => {
    app = buildApp();
    jest.clearAllMocks();
  });

  describe('IDOR & Cross-User Isolation', () => {
    it('prevents User A from reading private chat messages of User B and User C', async () => {
      // Booking belongs to student 1 and teacher 2; attacker is user 99
      db.query.mockResolvedValueOnce([[{ student_user_id: 1, teacher_user_id: 2, status: 'accepted' }]]);

      const res = await request(app)
        .get('/api/messages/10')
        .set('Authorization', `Bearer ${userToken(99, 'student')}`);

      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/not part of this conversation/i);
    });

    it('prevents User A from modifying Student profile of User B', async () => {
      const res = await request(app)
        .put('/api/students/2/location')
        .set('Authorization', `Bearer ${userToken(1, 'student')}`)
        .send({ address: 'Hacked Address' });

      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/only update your own account/i);
    });

    it('prevents student from modifying teacher location', async () => {
      const res = await request(app)
        .put('/api/teachers/1/location')
        .set('Authorization', `Bearer ${userToken(1, 'student')}`)
        .send({ latitude: 28.5, longitude: 77.2 });

      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/only teachers can perform this action/i);
    });
  });

  describe('SQL Injection & Input Sanitization', () => {
    it('safely handles SQL injection payloads in teacher search queries', async () => {
      db.query
        .mockResolvedValueOnce([[]])
        .mockResolvedValueOnce([[{ total: 0 }]]);

      const payload = "' OR '1'='1' -- ";
      const res = await request(app).get(`/api/teachers/browse?subject=${encodeURIComponent(payload)}`);

      expect(res.status).toBe(200);
      // Confirms parameterized query received the escaped literal string, not raw SQL execution
      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining('WHERE t.verification_status = \'approved\' AND t.subjects LIKE ?'),
        expect.arrayContaining([`%${payload.trim()}%`, 12, 0])
      );
    });
  });
});
