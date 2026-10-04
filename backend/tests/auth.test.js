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

// These unit tests cover request VALIDATION only (nothing here reaches the database).
// Everything that touches accounts, sessions, tokens and lockouts — signup, login, refresh,
// logout, password reset/change, email verification, Google sign-in — runs against real MySQL in
// tests/integration/auth.integration.test.js.

const valid = { name: 'Test User', email: 'test@example.com', phone: '9876543210', password: 'Str0ng!Passw0rd', role: 'student' };
const signup = (app, patch) => request(app).post('/api/auth/signup').send({ ...valid, ...patch });

describe('POST /api/auth/signup — validation', () => {
  let app;
  beforeEach(() => {
    app = buildApp();
    jest.resetAllMocks();
    process.env.JWT_SECRET = 'test_secret';
  });

  it('rejects an invalid email', async () => {
    const res = await signup(app, { email: 'not-an-email' });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/valid email/i);
  });

  it('rejects an over-long email before it reaches the database', async () => {
    const res = await signup(app, { email: `${'a'.repeat(150)}@example.com` });
    expect(res.status).toBe(422);
  });

  it('rejects an invalid Indian phone number', async () => {
    const res = await signup(app, { phone: '12345' });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/mobile number/i);
  });

  it.each([
    ['too short', '123', /at least 8/i],
    ['no uppercase', 'alllowercase1', /uppercase/i],
    ['no lowercase', 'ALLUPPERCASE1', /lowercase/i],
    ['no number', 'NoNumbersHere', /number/i],
    ['too common', 'Password123', /too common/i],
    ['longer than bcrypt can use (72 bytes)', `A1${'a'.repeat(80)}`, /at most 72/i],
  ])('rejects a password that is %s', async (_n, password, message) => {
    const res = await signup(app, { password });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(message);
  });

  it('rejects an invalid role (an attacker cannot self-register as admin)', async () => {
    const res = await signup(app, { role: 'admin' });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/student or teacher/i);
  });

  it('rejects a name that is too short', async () => {
    const res = await signup(app, { name: 'A' });
    expect(res.status).toBe(422);
  });
});

describe('POST /api/auth/login — validation', () => {
  let app;
  beforeEach(() => {
    app = buildApp();
    jest.resetAllMocks();
    process.env.JWT_SECRET = 'test_secret';
  });

  it('rejects a missing password', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'test@example.com' });
    expect(res.status).toBe(422);
  });

  it('rejects a malformed email', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'nope', password: 'x' });
    expect(res.status).toBe(422);
  });

  it('rejects a password sent as a non-string (JSON type confusion)', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'test@example.com', password: { $ne: '' } });
    expect(res.status).toBe(422);
  });
});

describe('POST /api/auth/refresh without a cookie', () => {
  it('answers 401 and never touches the database', async () => {
    const app = buildApp();
    const res = await request(app).post('/api/auth/refresh');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('SESSION_EXPIRED');
    expect(db.query).not.toHaveBeenCalled();
  });
});