const request = require('supertest');
const express = require('express');
const bcrypt = require('bcryptjs');

// ---- Mock the DB and outbound side effects so these tests are fast,
// deterministic, and don't need a real MySQL server or SMTP/Twilio
// credentials to run. ----
jest.mock('../config/db', () => ({ query: jest.fn() }));
jest.mock('../config/email', () => ({ sendMail: jest.fn().mockResolvedValue() }));

const db = require('../config/db');
const authRoutes = require('../routes/auth.routes');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  return app;
}

describe('POST /api/auth/signup', () => {
  let app;
  beforeEach(() => {
    app = buildApp();
    jest.clearAllMocks();
    process.env.JWT_SECRET = 'test_secret';
  });

  it('rejects a signup with an invalid email', async () => {
    const res = await request(app).post('/api/auth/signup').send({
      name: 'Test User',
      email: 'not-an-email',
      phone: '9876543210',
      password: 'password123',
      role: 'student',
    });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/valid email/i);
  });

  it('rejects a signup with an invalid Indian phone number', async () => {
    const res = await request(app).post('/api/auth/signup').send({
      name: 'Test User',
      email: 'test@example.com',
      phone: '12345',
      password: 'password123',
      role: 'student',
    });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/mobile number/i);
  });

  it('rejects a signup with a short password', async () => {
    const res = await request(app).post('/api/auth/signup').send({
      name: 'Test User',
      email: 'test@example.com',
      phone: '9876543210',
      password: '123',
      role: 'student',
    });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/6 characters/i);
  });

  it('rejects an invalid role', async () => {
    const res = await request(app).post('/api/auth/signup').send({
      name: 'Test User',
      email: 'test@example.com',
      phone: '9876543210',
      password: 'password123',
      role: 'admin',
    });
    expect(res.status).toBe(422);
  });

  it('rejects signup when the email is already registered', async () => {
    db.query.mockResolvedValueOnce([[{ id: 1 }]]); // existing email lookup finds a row

    const res = await request(app).post('/api/auth/signup').send({
      name: 'Test User',
      email: 'taken@example.com',
      phone: '9876543210',
      password: 'password123',
      role: 'student',
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/email already exists/i);
  });

  it('creates a student account successfully with valid input', async () => {
    db.query
      .mockResolvedValueOnce([[]])                 // no existing email
      .mockResolvedValueOnce([[]])                 // no existing phone
      .mockResolvedValueOnce([{ insertId: 42 }])    // INSERT INTO users
      .mockResolvedValueOnce([{}]);                 // INSERT INTO students

    const res = await request(app).post('/api/auth/signup').send({
      name: 'Priya Sharma',
      email: 'priya@example.com',
      phone: '9876543210',
      password: 'password123',
      role: 'student',
    });

    expect(res.status).toBe(201);
    expect(res.headers['set-cookie'][0]).toMatch(/^token=/);
    expect(res.body.user.email).toBe('priya@example.com');
  });
});

describe('POST /api/auth/login', () => {
  let app;
  beforeEach(() => {
    app = buildApp();
    jest.clearAllMocks();
    process.env.JWT_SECRET = 'test_secret';
  });

  it('rejects login with missing password', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'a@example.com' });
    expect(res.status).toBe(422);
  });

  it('rejects login for a non-existent email without revealing that', async () => {
    db.query.mockResolvedValueOnce([[]]);
    const res = await request(app).post('/api/auth/login').send({ email: 'nobody@example.com', password: 'whatever' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid email or password.');
  });

  it('rejects an incorrect password and increments failed attempts', async () => {
    const hash = await bcrypt.hash('correct-password', 10);
    db.query
      .mockResolvedValueOnce([[{ id: 1, password_hash: hash, failed_login_attempts: 0, locked_until: null, role: 'student' }]])
      .mockResolvedValueOnce([{}]); // the UPDATE that records the failed attempt

    const res = await request(app).post('/api/auth/login').send({ email: 'a@example.com', password: 'wrong-password' });
    expect(res.status).toBe(401);
  });

  it('logs in successfully with the correct password', async () => {
    const hash = await bcrypt.hash('correct-password', 10);
    db.query
      .mockResolvedValueOnce([[{
        id: 1, name: 'Priya', email: 'a@example.com', role: 'student',
        password_hash: hash, failed_login_attempts: 0, locked_until: null,
      }]]);

    const res = await request(app).post('/api/auth/login').send({ email: 'a@example.com', password: 'correct-password' });
    expect(res.status).toBe(200);
    expect(res.headers['set-cookie'][0]).toMatch(/^token=/);
    expect(res.body.user.role).toBe('student');
  });

  it('locks the account after 5 failed attempts', async () => {
    const hash = await bcrypt.hash('correct-password', 10);
    db.query
      .mockResolvedValueOnce([[{ id: 1, password_hash: hash, failed_login_attempts: 4, locked_until: null, role: 'student' }]])
      .mockResolvedValueOnce([{}]); // the UPDATE that locks the account

    const res = await request(app).post('/api/auth/login').send({ email: 'a@example.com', password: 'wrong-password' });
    expect(res.status).toBe(423);
    expect(res.body.error).toMatch(/locked/i);
  });
});