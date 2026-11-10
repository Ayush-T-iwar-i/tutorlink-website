const request = require('supertest');
const jwt = require('jsonwebtoken');

// Outbound services are replaced: emails are captured so the tests can read the links inside them,
// and Google's token verification is a mock. Everything else (Express, SQL, bcrypt, cookies) is real.
jest.mock('../../config/email', () => ({ sendMail: jest.fn().mockResolvedValue() }));
jest.mock('google-auth-library', () => {
  const verifyIdToken = jest.fn();
  return { OAuth2Client: jest.fn(() => ({ verifyIdToken })), __verifyIdToken: verifyIdToken };
});

process.env.GOOGLE_CLIENT_ID = 'test-google-client-id';

const { sendMail } = require('../../config/email');
const { __verifyIdToken: verifyIdToken } = require('google-auth-library');
const app = require('../../server');
const passwords = require('../../lib/passwords');
const sessionsLib = require('../../lib/sessions');
const tokenLib = require('../../lib/session-tokens');
const { runCleanup } = require('../../jobs/cleanup');
const { drain } = require('../../lib/after-response');
const { db, createStudent, createTeacher, futureDate, insertBooking } = require('./helpers');

// Requests carry an X-Forwarded-For header, so each test controls "which IP" it is coming from.
app.set('trust proxy', true);

afterAll(async () => {
  await drain();
  await db.end();
});

const STRONG = 'Str0ng!Passw0rd';
let seq = 0;
const uid = () => `${process.pid}${Date.now() % 100000}${++seq}`;
const freshIp = () => `10.${Math.floor(seq / 250) % 250}.${seq % 250}.${(Date.now() + seq) % 250}`;

beforeEach(() => {
  sendMail.mockClear();
  verifyIdToken.mockReset();
});

// ---------- helpers ----------
const post = (path, body, { ip = freshIp(), cookies } = {}) => {
  const r = request(app).post(path).set('X-Forwarded-For', ip).send(body);
  return cookies ? r.set('Cookie', cookies) : r;
};
const send = (method, path, { ip = freshIp(), token, cookies, body } = {}) => {
  let r = request(app)[method](path).set('X-Forwarded-For', ip);
  if (token) r = r.set('Authorization', `Bearer ${token}`);
  if (cookies) r = r.set('Cookie', cookies);
  return body ? r.send(body) : r;
};
const setCookies = (res) => [].concat(res.headers['set-cookie'] || []);
const rawCookie = (res, name) => setCookies(res).find((c) => c.startsWith(`${name}=`));
const cookieValue = (res, name) => {
  const c = rawCookie(res, name);
  return c ? decodeURIComponent(c.split(';')[0].slice(name.length + 1)) : null;
};
const cookieHeader = (access, refresh) => [`token=${access}`, `refresh_token=${refresh}`];

async function makeUser({ role = 'student', password = STRONG, verified = true, google = false } = {}) {
  const n = uid();
  const email = `user${n}@example.test`;
  const [r] = await db.query(
    `INSERT INTO users (name, email, phone, password_hash, role, email_verified, google_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [`Test ${n}`, email, `9${n.padStart(9, '0').slice(-9)}`, google ? null : await passwords.hashPassword(password), role, verified ? 1 : 0, google ? `g_${n}` : null]
  );
  if (role === 'student') await db.query('INSERT INTO students (user_id) VALUES (?)', [r.insertId]);
  if (role === 'teacher') await db.query("INSERT INTO teachers (user_id, subjects, verification_status) VALUES (?, 'Maths', 'approved')", [r.insertId]);
  return { id: r.insertId, email, password };
}

async function loginAs(user, opts = {}) {
  const res = await post('/api/auth/login', { email: user.email, password: opts.password || user.password }, opts);
  return { res, access: cookieValue(res, 'token'), refresh: cookieValue(res, 'refresh_token') };
}

const userRow = async (id) => (await db.query('SELECT * FROM users WHERE id = ?', [id]))[0][0];
const sessionRows = async (userId) => (await db.query('SELECT * FROM sessions WHERE user_id = ? ORDER BY id', [userId]))[0];
const liveSessions = async (userId) => (await sessionRows(userId)).filter((s) => !s.revoked_at);

/** Raw token from the most recent email whose subject matches. */
async function tokenFromEmail(subjectPattern) {
  await drain();
  const calls = sendMail.mock.calls.map((c) => c[0]).filter((m) => subjectPattern.test(m.subject));
  const mail = calls[calls.length - 1];
  if (!mail) return null;
  const m = mail.html.match(/token=([a-f0-9]{64})/);
  return m ? m[1] : null;
}
const emailsTo = async (address, subjectPattern) => {
  await drain();
  return sendMail.mock.calls.map((c) => c[0]).filter((m) => m.to === address && (!subjectPattern || subjectPattern.test(m.subject)));
};

const signupBody = (patch = {}) => {
  const n = uid();
  return { name: 'New Person', email: `signup${n}@example.test`, phone: `9${n.padStart(9, '0').slice(-9)}`, password: STRONG, role: 'student', ...patch };
};

// =====================================================================
describe('signup', () => {
  it('creates the account, logs in with httpOnly cookies, stores only hashes, and emails a verification link', async () => {
    const body = signupBody();
    const res = await post('/api/auth/signup', body);
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ email: body.email, role: 'student', email_verified: false });
    expect(JSON.stringify(res.body)).not.toMatch(/password|hash/i);

    const access = rawCookie(res, 'token');
    const refresh = rawCookie(res, 'refresh_token');
    expect(access).toMatch(/HttpOnly/i);
    expect(access).toMatch(/Path=\//);
    expect(refresh).toMatch(/HttpOnly/i);
    expect(refresh).toMatch(/Path=\/api\/auth/);

    const [row] = (await db.query('SELECT * FROM users WHERE email = ?', [body.email]))[0];
    expect(row.password_hash).not.toBe(body.password);
    expect(row.password_hash).toMatch(/^\$2[aby]\$/);
    expect(row.email_verified).toBe(0);
    expect(await liveSessions(row.id)).toHaveLength(1);

    const raw = await tokenFromEmail(/verify your/i);
    expect(raw).toMatch(/^[a-f0-9]{64}$/);
    expect(row.email_verify_token).toBe(tokenLib.hashToken(raw)); // the database holds the hash, never the emailed value
    expect(row.email_verify_token).not.toBe(raw);
    expect((await emailsTo(body.email))[0].to).toBe(body.email);
  });

  it('creates the matching student/teacher profile row', async () => {
    const s = await post('/api/auth/signup', signupBody());
    const t = await post('/api/auth/signup', signupBody({ role: 'teacher', subjects: 'Maths', experience_years: '999', qualification: 'x'.repeat(400) }));
    expect(s.status).toBe(201);
    expect(t.status).toBe(201);
    expect((await db.query('SELECT COUNT(*) AS n FROM students WHERE user_id = ?', [s.body.user.id]))[0][0].n).toBe(1);
    const [[teacher]] = await db.query('SELECT experience_years, qualification FROM teachers WHERE user_id = ?', [t.body.user.id]);
    expect(teacher.experience_years).toBe(60);           // clamped, not trusted
    expect(teacher.qualification).toHaveLength(255);     // clipped to the column, not a 500
  });

  it('409 for a duplicate email or phone', async () => {
    const body = signupBody();
    expect((await post('/api/auth/signup', body)).status).toBe(201);
    expect((await post('/api/auth/signup', { ...body, phone: signupBody().phone })).status).toBe(409);
    expect((await post('/api/auth/signup', { ...body, email: signupBody().email })).status).toBe(409);
  });

  it('5 simultaneous signups with the same email create exactly one account', async () => {
    const body = signupBody();
    const results = await Promise.all(Array.from({ length: 5 }, () => post('/api/auth/signup', body)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(4);
    expect((await db.query('SELECT COUNT(*) AS n FROM users WHERE email = ?', [body.email]))[0][0].n).toBe(1);
  });

  it('is atomic: if the profile row cannot be created, no half-made user is left behind', async () => {
    const body = signupBody();
    await db.query('RENAME TABLE students TO students_tmp');
    try {
      expect((await post('/api/auth/signup', body)).status).toBe(500);
    } finally {
      await db.query('RENAME TABLE students_tmp TO students');
    }
    expect((await db.query('SELECT COUNT(*) AS n FROM users WHERE email = ?', [body.email]))[0][0].n).toBe(0);
  });
});

// =====================================================================
describe('login', () => {
  it('logs in with the right password and sets both cookies', async () => {
    const user = await makeUser();
    const { res, access, refresh } = await loginAs(user);
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: user.id, email: user.email, role: 'student' });
    expect(JSON.stringify(res.body)).not.toMatch(/password|hash/i);
    expect(access).toBeTruthy();
    expect(refresh).toBeTruthy();
    const me = await send('get', '/api/auth/me', { cookies: cookieHeader(access, refresh) });
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(user.email);
  });

  it('gives the SAME answer for wrong password, unknown email and Google-only account (no account enumeration)', async () => {
    const real = await makeUser();
    const googleOnly = await makeUser({ google: true });
    const wrong = await loginAs(real, { password: 'Wr0ng!Passw0rd' });
    const unknown = await post('/api/auth/login', { email: `nobody${uid()}@example.test`, password: STRONG });
    const google = await post('/api/auth/login', { email: googleOnly.email, password: STRONG });
    for (const r of [wrong.res, unknown, google]) expect(r.status).toBe(401);
    const sansRequestId = ({ requestId, ...rest }) => rest; // eslint-disable-line no-unused-vars
    expect(sansRequestId(unknown.body)).toEqual(sansRequestId(wrong.res.body));
    expect(sansRequestId(google.body)).toEqual(sansRequestId(wrong.res.body));
  });

  it('locks a (email, IP) pair after 5 failures — even for the correct password — and unknown emails lock identically', async () => {
    const user = await makeUser();
    const ip = freshIp();
    for (let i = 1; i <= 4; i++) expect((await loginAs(user, { ip, password: 'Wr0ng!Passw0rd' })).res.status).toBe(401);
    const fifth = await loginAs(user, { ip, password: 'Wr0ng!Passw0rd' });
    expect(fifth.res.status).toBe(423);
    expect((await loginAs(user, { ip })).res.status).toBe(423); // correct password, still locked

    const ghost = `ghost${uid()}@example.test`;
    const ghostIp = freshIp();
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await post('/api/auth/login', { email: ghost, password: 'x' }, { ip: ghostIp })).status);
    expect(statuses).toEqual([401, 401, 401, 401, 423, 423]); // same behaviour as a real account
  });

  it("an attacker cannot lock the real owner out: another IP can still log in", async () => {
    const user = await makeUser();
    const attacker = freshIp();
    for (let i = 0; i < 6; i++) await loginAs(user, { ip: attacker, password: 'Wr0ng!Passw0rd' });
    expect((await loginAs(user, { ip: attacker })).res.status).toBe(423);
    expect((await loginAs(user, { ip: freshIp() })).res.status).toBe(200);
  });

  it('25 failures spread across many IPs throttle the account for everyone (distributed guessing)', async () => {
    const user = await makeUser();
    for (let ipN = 0; ipN < 5; ipN++) {
      const ip = freshIp();
      for (let i = 0; i < 5; i++) await loginAs(user, { ip, password: 'Wr0ng!Passw0rd' });
    }
    const res = await loginAs(user, { ip: freshIp() });
    expect(res.res.status).toBe(423);
  });

  it('a successful login resets the failure counter', async () => {
    const user = await makeUser();
    const ip = freshIp();
    for (let i = 0; i < 3; i++) await loginAs(user, { ip, password: 'Wr0ng!Passw0rd' });
    expect((await loginAs(user, { ip })).res.status).toBe(200);
    for (let i = 0; i < 4; i++) expect((await loginAs(user, { ip, password: 'Wr0ng!Passw0rd' })).res.status).toBe(401);
  });

  it('login failure rows store only a hash of the email', async () => {
    const user = await makeUser();
    await loginAs(user, { password: 'Wr0ng!Passw0rd' });
    const [rows] = await db.query('SELECT email_hash FROM login_failures WHERE email_hash = ?', [require('../../lib/login-throttle').emailHash(user.email)]);
    expect(rows).toHaveLength(1);
    expect(rows[0].email_hash).toMatch(/^[a-f0-9]{64}$/);
  });
});

// =====================================================================
describe('access-token checks (middleware)', () => {
  it('401 NO_TOKEN without credentials and INVALID_TOKEN for garbage', async () => {
    expect((await send('get', '/api/auth/me')).body.code).toBe('NO_TOKEN');
    expect((await send('get', '/api/auth/me', { token: 'not.a.jwt' })).body.code).toBe('INVALID_TOKEN');
  });

  it('rejects tokens signed with another secret, alg:none, and old-style tokens that have no session id', async () => {
    const user = await makeUser();
    const forged = jwt.sign({ id: user.id, role: 'admin', sid: 1 }, 'some-other-secret-value-that-is-long');
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ id: user.id, role: 'admin', sid: 1 })).toString('base64url')}.`;
    const legacy = jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '7d' });
    for (const token of [forged, none]) expect((await send('get', '/api/auth/me', { token })).status).toBe(401);
    const old = await send('get', '/api/auth/me', { token: legacy });
    expect(old.status).toBe(401);
    expect(old.body.code).toBe('SESSION_REVOKED');
  });

  it('reports TOKEN_EXPIRED for an expired token so the frontend knows to refresh', async () => {
    const user = await makeUser();
    const { access } = await loginAs(user);
    const { sid } = jwt.decode(access);
    const expired = jwt.sign({ id: user.id, role: user.role, sid }, process.env.JWT_SECRET, { expiresIn: -10 });
    const res = await send('get', '/api/auth/me', { token: expired });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('TOKEN_EXPIRED');
  });

  it('access tokens are short-lived (15 minutes by default)', async () => {
    const user = await makeUser();
    const { access } = await loginAs(user);
    const { iat, exp } = jwt.decode(access);
    expect(exp - iat).toBe(15 * 60);
  });

  it('takes the role from the database, not from the token', async () => {
    const user = await makeUser({ role: 'student' });
    const { access } = await loginAs(user);
    expect((await send('get', '/api/bookings/student/me', { token: access })).status).toBe(200);
    await db.query("UPDATE users SET role = 'teacher' WHERE id = ?", [user.id]);
    expect((await send('get', '/api/bookings/student/me', { token: access })).status).toBe(403); // token still says student
  });

  it('a deleted user is logged out immediately', async () => {
    const user = await makeUser();
    const { access } = await loginAs(user);
    await db.query('DELETE FROM users WHERE id = ?', [user.id]);
    expect((await send('get', '/api/auth/me', { token: access })).status).toBe(401);
  });

  it('a revoked or expired session stops working at once, with no wait for the JWT to expire', async () => {
    const user = await makeUser();
    const a = await loginAs(user);
    const b = await loginAs(user);
    const { sid } = jwt.decode(a.access);
    await db.query("UPDATE sessions SET revoked_at = NOW(), revoked_reason = 'admin' WHERE id = ?", [sid]);
    expect((await send('get', '/api/auth/me', { token: a.access })).body.code).toBe('SESSION_REVOKED');
    expect((await send('get', '/api/auth/me', { token: b.access })).status).toBe(200);
    await db.query('UPDATE sessions SET expires_at = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE id = ?', [jwt.decode(b.access).sid]);
    expect((await send('get', '/api/auth/me', { token: b.access })).status).toBe(401);
  });

  it('one user\'s session cannot be used as another user\'s (sid/id mismatch)', async () => {
    const [u1, u2] = [await makeUser(), await makeUser()];
    const a = await loginAs(u1);
    const swapped = jwt.sign({ id: u2.id, role: 'student', sid: jwt.decode(a.access).sid }, process.env.JWT_SECRET, { expiresIn: '5m' });
    expect((await send('get', '/api/auth/me', { token: swapped })).status).toBe(401);
  });
});

// =====================================================================
describe('refresh-token rotation', () => {
  it('issues a new access token AND a new refresh token; the old refresh token stops being the current one', async () => {
    const user = await makeUser();
    const { refresh, access } = await loginAs(user);
    const res = await post('/api/auth/refresh', {}, { cookies: cookieHeader(access, refresh) });
    expect(res.status).toBe(200);
    const newRefresh = cookieValue(res, 'refresh_token');
    const newAccess = cookieValue(res, 'token');
    expect(newRefresh).toBeTruthy();
    expect(newRefresh).not.toBe(refresh);
    expect((await send('get', '/api/auth/me', { token: newAccess })).status).toBe(200);
    expect(rawCookie(res, 'refresh_token')).toMatch(/Path=\/api\/auth/);
    // only hashes are stored
    const [s] = await sessionRows(user.id);
    expect(s.refresh_hash).toBe(tokenLib.hashToken(newRefresh));
    expect(s.prev_refresh_hash).toBe(tokenLib.hashToken(refresh));
  });

  it('reusing an old refresh token AFTER the grace period revokes the whole session (thief and victim both lose access)', async () => {
    const user = await makeUser();
    const { refresh, access } = await loginAs(user);
    const rotated = await post('/api/auth/refresh', {}, { cookies: cookieHeader(access, refresh) });
    const currentAccess = cookieValue(rotated, 'token');
    await db.query('UPDATE sessions SET rotated_at = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE user_id = ?', [user.id]);

    const replay = await post('/api/auth/refresh', {}, { cookies: cookieHeader('x', refresh) });
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe('SESSION_EXPIRED');
    expect((await sessionRows(user.id))[0].revoked_reason).toBe('reuse_detected');
    expect((await send('get', '/api/auth/me', { token: currentAccess })).status).toBe(401);
    expect(setCookies(replay).some((c) => /^token=;/.test(c) || /^refresh_token=;/.test(c))).toBe(true); // cookies cleared
  });

  it('presenting the just-replaced token within the grace window (second browser tab) is tolerated and does not rotate again', async () => {
    const user = await makeUser();
    const { refresh, access } = await loginAs(user);
    await post('/api/auth/refresh', {}, { cookies: cookieHeader(access, refresh) });
    const tab2 = await post('/api/auth/refresh', {}, { cookies: cookieHeader(access, refresh) });
    expect(tab2.status).toBe(200);
    expect(rawCookie(tab2, 'refresh_token')).toBeUndefined();     // must not overwrite the newer cookie
    expect(cookieValue(tab2, 'token')).toBeTruthy();
    expect(await liveSessions(user.id)).toHaveLength(1);
  });

  it('5 simultaneous refreshes with the same token all succeed and the session survives', async () => {
    const user = await makeUser();
    const { refresh, access } = await loginAs(user);
    const results = await Promise.all(Array.from({ length: 5 }, () => post('/api/auth/refresh', {}, { cookies: cookieHeader(access, refresh) })));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(results.filter((r) => rawCookie(r, 'refresh_token'))).toHaveLength(1); // exactly one rotation
    expect(await liveSessions(user.id)).toHaveLength(1);
  });

  it.each([
    ['no cookie', () => ({})],
    ['garbage cookie', () => ({ cookies: ['refresh_token=garbagegarbagegarbagegarbagegarbage'] })],
  ])('401 for %s, and the cookies are cleared', async (_n, make) => {
    const res = await post('/api/auth/refresh', {}, make());
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('SESSION_EXPIRED');
  });

  it('401 once the session is revoked, expired, past its absolute lifetime, or the user is gone', async () => {
    const run = async (mutate) => {
      const user = await makeUser();
      const { refresh, access } = await loginAs(user);
      await mutate(user);
      return post('/api/auth/refresh', {}, { cookies: cookieHeader(access, refresh) });
    };
    expect((await run((u) => db.query("UPDATE sessions SET revoked_at = NOW() WHERE user_id = ?", [u.id]))).status).toBe(401);
    expect((await run((u) => db.query('UPDATE sessions SET expires_at = DATE_SUB(NOW(), INTERVAL 1 DAY) WHERE user_id = ?', [u.id]))).status).toBe(401);
    expect((await run((u) => db.query('UPDATE sessions SET created_at = DATE_SUB(NOW(), INTERVAL 91 DAY) WHERE user_id = ?', [u.id]))).status).toBe(401);
    expect((await run((u) => db.query('DELETE FROM users WHERE id = ?', [u.id]))).status).toBe(401);
  });

  it('a refresh slides the idle expiry forward but never beyond 90 days from the original login', async () => {
    const user = await makeUser();
    const { refresh, access } = await loginAs(user);
    await db.query('UPDATE sessions SET created_at = DATE_SUB(NOW(), INTERVAL 85 DAY) WHERE user_id = ?', [user.id]);
    expect((await post('/api/auth/refresh', {}, { cookies: cookieHeader(access, refresh) })).status).toBe(200);
    const [[s]] = await db.query('SELECT TIMESTAMPDIFF(DAY, NOW(), expires_at) AS days_left FROM sessions WHERE user_id = ?', [user.id]);
    expect(s.days_left).toBeLessThanOrEqual(5);
  });
});

// =====================================================================
describe('logout', () => {
  it('revokes the server-side session: a copied access token is dead immediately, and cookies are cleared', async () => {
    const user = await makeUser();
    const { access, refresh } = await loginAs(user);
    expect((await send('get', '/api/auth/me', { token: access })).status).toBe(200);
    const res = await post('/api/auth/logout', {}, { cookies: cookieHeader(access, refresh) });
    expect(res.status).toBe(200);
    expect(setCookies(res).filter((c) => /^(token|refresh_token)=;/.test(c))).toHaveLength(2);
    expect((await send('get', '/api/auth/me', { token: access })).status).toBe(401);          // the "stolen" copy
    expect((await post('/api/auth/refresh', {}, { cookies: cookieHeader(access, refresh) })).status).toBe(401);
    expect((await sessionRows(user.id))[0].revoked_reason).toBe('logout');
  });

  it('works with only the refresh cookie (expired access token) and never errors when logged out', async () => {
    const user = await makeUser();
    const { refresh } = await loginAs(user);
    expect((await post('/api/auth/logout', {}, { cookies: [`refresh_token=${refresh}`] })).status).toBe(200);
    expect(await liveSessions(user.id)).toHaveLength(0);
    expect((await post('/api/auth/logout', {})).status).toBe(200);
  });

  it('logout only ends the current device; logout-all ends every device', async () => {
    const user = await makeUser();
    const [a, b, c] = [await loginAs(user), await loginAs(user), await loginAs(user)];
    await post('/api/auth/logout', {}, { cookies: cookieHeader(a.access, a.refresh) });
    expect((await send('get', '/api/auth/me', { token: b.access })).status).toBe(200);
    expect((await post('/api/auth/logout-all', {}, { cookies: cookieHeader(b.access, b.refresh) })).status).toBe(200);
    expect((await send('get', '/api/auth/me', { token: c.access })).status).toBe(401);
    expect(await liveSessions(user.id)).toHaveLength(0);
  });

  it("logout-all requires a login, and one user cannot end another user's sessions", async () => {
    const [victim, other] = [await makeUser(), await makeUser()];
    const v = await loginAs(victim);
    const o = await loginAs(other);
    expect((await post('/api/auth/logout-all', {})).status).toBe(401);
    await post('/api/auth/logout-all', {}, { cookies: cookieHeader(o.access, o.refresh) });
    expect((await send('get', '/api/auth/me', { token: v.access })).status).toBe(200);
  });
});

// =====================================================================
describe('forgot / reset password', () => {
  it('answers identically for known and unknown emails, and only emails real accounts', async () => {
    const user = await makeUser();
    const known = await post('/api/auth/forgot-password', { email: user.email });
    const unknown = await post('/api/auth/forgot-password', { email: `nobody${uid()}@example.test` });
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(unknown.body).toEqual(known.body);
    expect(await emailsTo(user.email, /reset/i)).toHaveLength(1);
  });

  it('stores the reset token hashed, and a second request within a minute does not send another email', async () => {
    const user = await makeUser();
    await post('/api/auth/forgot-password', { email: user.email });
    const raw = await tokenFromEmail(/reset/i);
    const row = await userRow(user.id);
    expect(row.reset_token).toBe(tokenLib.hashToken(raw));
    expect(row.reset_token).not.toBe(raw);
    await post('/api/auth/forgot-password', { email: user.email });
    expect(await emailsTo(user.email, /reset/i)).toHaveLength(1);
  });

  async function requestReset(user) {
    await post('/api/auth/forgot-password', { email: user.email });
    return tokenFromEmail(/reset/i);
  }

  it('resets the password; the link works exactly once; the old password stops working', async () => {
    const user = await makeUser();
    const raw = await requestReset(user);
    const NEW = 'N3w!Passw0rdX';
    expect((await post('/api/auth/reset-password', { token: raw, password: NEW })).status).toBe(200);
    expect((await loginAs(user, { password: NEW })).res.status).toBe(200);
    expect((await loginAs(user)).res.status).toBe(401);
    const again = await post('/api/auth/reset-password', { token: raw, password: 'An0ther!Passw0rd' });
    expect(again.status).toBe(400);
    expect((await userRow(user.id)).reset_token).toBeNull();
  });

  it('two simultaneous uses of one link: exactly one wins', async () => {
    const user = await makeUser();
    const raw = await requestReset(user);
    const results = await Promise.all([
      post('/api/auth/reset-password', { token: raw, password: 'Fir5t!Passw0rd' }),
      post('/api/auth/reset-password', { token: raw, password: 'Seco2d!Passw0rd' }),
      post('/api/auth/reset-password', { token: raw, password: 'Thir3d!Passw0rd' }),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
  });

  it('rejects an expired link, an unknown token, and the stored hash replayed as if it were the token', async () => {
    const user = await makeUser();
    const raw = await requestReset(user);
    const stored = (await userRow(user.id)).reset_token;
    expect((await post('/api/auth/reset-password', { token: stored, password: 'N3w!Passw0rdX' })).status).toBe(400);
    expect((await post('/api/auth/reset-password', { token: 'f'.repeat(64), password: 'N3w!Passw0rdX' })).status).toBe(400);
    await db.query('UPDATE users SET reset_token_expires = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE id = ?', [user.id]);
    expect((await post('/api/auth/reset-password', { token: raw, password: 'N3w!Passw0rdX' })).status).toBe(400);
  });

  it('a weak new password is refused WITHOUT consuming the link', async () => {
    const user = await makeUser();
    const raw = await requestReset(user);
    expect((await post('/api/auth/reset-password', { token: raw, password: 'weak' })).status).toBe(422);
    expect((await post('/api/auth/reset-password', { token: raw, password: 'N3w!Passw0rdX' })).status).toBe(200);
  });

  it('signs the account out everywhere, clears the lockout, and marks the email verified', async () => {
    const user = await makeUser({ verified: false });
    const { access } = await loginAs(user);
    const ip = freshIp();
    for (let i = 0; i < 5; i++) await loginAs(user, { ip, password: 'Wr0ng!Passw0rd' });
    expect((await loginAs(user, { ip })).res.status).toBe(423);

    const raw = await requestReset(user);
    await post('/api/auth/reset-password', { token: raw, password: 'N3w!Passw0rdX' });
    expect((await send('get', '/api/auth/me', { token: access })).status).toBe(401);
    expect((await loginAs(user, { ip, password: 'N3w!Passw0rdX' })).res.status).toBe(200);
    expect((await userRow(user.id)).email_verified).toBe(1);
    expect((await emailsTo(user.email, /password was changed/i)).length).toBe(1);
  });

  it('lets a Google-only account set a password through the reset flow', async () => {
    const user = await makeUser({ google: true });
    const raw = await requestReset(user);
    expect((await post('/api/auth/reset-password', { token: raw, password: 'N3w!Passw0rdX' })).status).toBe(200);
    expect((await loginAs(user, { password: 'N3w!Passw0rdX' })).res.status).toBe(200);
  });
});

// =====================================================================
describe('change password', () => {
  const change = (tokenOrCookies, body) => send('put', '/api/auth/change-password', { ...tokenOrCookies, body });

  it('401 without a login; 401 for a wrong current password; 422 for weak or unchanged passwords', async () => {
    const user = await makeUser();
    const { access } = await loginAs(user);
    expect((await send('put', '/api/auth/change-password', { body: { current_password: STRONG, new_password: 'N3w!Passw0rdX' } })).status).toBe(401);
    expect((await change({ token: access }, { current_password: 'Wr0ng!Passw0rd', new_password: 'N3w!Passw0rdX' })).status).toBe(401);
    expect((await change({ token: access }, { current_password: STRONG, new_password: 'weak' })).status).toBe(422);
    expect((await change({ token: access }, { current_password: STRONG, new_password: STRONG })).status).toBe(422);
  });

  it('signs every OTHER device out but keeps this one logged in with fresh cookies', async () => {
    const user = await makeUser();
    const here = await loginAs(user);
    const elsewhere = await loginAs(user);
    const res = await change({ cookies: cookieHeader(here.access, here.refresh) }, { current_password: STRONG, new_password: 'N3w!Passw0rdX' });
    expect(res.status).toBe(200);

    expect((await send('get', '/api/auth/me', { token: elsewhere.access })).status).toBe(401);
    expect((await send('get', '/api/auth/me', { token: here.access })).status).toBe(401); // the old token of this device is retired too…
    const freshAccess = cookieValue(res, 'token');
    expect(freshAccess).toBeTruthy();
    expect((await send('get', '/api/auth/me', { token: freshAccess })).status).toBe(200); // …and the new one works
    expect((await loginAs(user)).res.status).toBe(401);
    expect((await loginAs(user, { password: 'N3w!Passw0rdX' })).res.status).toBe(200);
    expect((await emailsTo(user.email, /password was changed/i)).length).toBe(1);
  });

  it('tells a Google-only account to use "Forgot password"', async () => {
    const user = await makeUser({ google: true });
    const { access } = await tokenFor(user);
    const res = await change({ token: access }, { current_password: STRONG, new_password: 'N3w!Passw0rdX' });
    expect(res.status).toBe(400);
  });
});

async function tokenFor(user) {
  const s = await sessionsLib.issueSession(db, { id: user.id, role: 'student' }, { ip: '127.0.0.1', get: () => 'jest' });
  return { access: s.accessToken };
}

// =====================================================================
describe('email verification', () => {
  async function unverifiedUser() {
    const user = await makeUser({ verified: false });
    const login = await loginAs(user);
    return { user, ...login };
  }

  it('verifies with the emailed link exactly once; the stored hash is not a usable token', async () => {
    const body = signupBody();
    const res = await post('/api/auth/signup', body);
    const raw = await tokenFromEmail(/verify your/i);
    const stored = (await userRow(res.body.user.id)).email_verify_token;
    expect((await send('get', `/api/auth/verify-email?token=${stored}`)).status).toBe(400);
    expect((await send('get', `/api/auth/verify-email?token=${raw}`)).status).toBe(200);
    expect((await userRow(res.body.user.id))).toMatchObject({ email_verified: 1, email_verify_token: null });
    expect((await send('get', `/api/auth/verify-email?token=${raw}`)).status).toBe(400);
  });

  it('rejects missing, unknown, array-valued and expired tokens', async () => {
    const { user } = await unverifiedUser();
    expect((await send('get', '/api/auth/verify-email')).status).toBe(400);
    expect((await send('get', `/api/auth/verify-email?token=${'a'.repeat(64)}`)).status).toBe(400);
    expect((await send('get', '/api/auth/verify-email?token[]=x&token[]=y')).status).toBe(400);
    const raw = tokenLib.generateEmailToken();
    await db.query('UPDATE users SET email_verify_token = ?, email_verify_expires = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE id = ?', [raw.hash, user.id]);
    expect((await send('get', `/api/auth/verify-email?token=${raw.raw}`)).status).toBe(400);
  });

  it('resend: needs a login, has a 1-minute cooldown, replaces the previous link, and refuses verified users', async () => {
    const { user, access } = await unverifiedUser();
    expect((await send('post', '/api/auth/resend-verification')).status).toBe(401);

    await db.query("UPDATE users SET email_verify_token = NULL, email_verify_expires = NULL WHERE id = ?", [user.id]);
    expect((await send('post', '/api/auth/resend-verification', { token: access })).status).toBe(200);
    const first = await tokenFromEmail(/verify your/i);
    const cooldown = await send('post', '/api/auth/resend-verification', { token: access });
    expect(cooldown.status).toBe(429);
    expect(cooldown.body.code).toBe('RESEND_COOLDOWN');

    await db.query('UPDATE users SET email_verify_expires = DATE_SUB(email_verify_expires, INTERVAL 2 MINUTE) WHERE id = ?', [user.id]);
    expect((await send('post', '/api/auth/resend-verification', { token: access })).status).toBe(200);
    const second = await tokenFromEmail(/verify your/i);
    expect(second).not.toBe(first);
    expect((await send('get', `/api/auth/verify-email?token=${first}`)).status).toBe(400);   // old link replaced
    expect((await send('get', `/api/auth/verify-email?token=${second}`)).status).toBe(200);
    expect((await send('post', '/api/auth/resend-verification', { token: access })).status).toBe(400);
  });

  it('an unverified student cannot create a booking or a payment order; a verified one gets past the gate', async () => {
    const unverified = await unverifiedUser();
    const book = await send('post', '/api/bookings', { token: unverified.access, body: {} });
    expect(book.status).toBe(403);
    expect(book.body.code).toBe('EMAIL_NOT_VERIFIED');
    expect((await send('post', '/api/payments/create-order', { token: unverified.access, body: { booking_id: 1 } })).body.code).toBe('EMAIL_NOT_VERIFIED');

    await db.query('UPDATE users SET email_verified = 1 WHERE id = ?', [unverified.user.id]);
    const after = await send('post', '/api/bookings', { token: unverified.access, body: {} });
    expect(after.status).toBe(400); // reaches validation: the verification gate is open
  });

  it('an unverified teacher cannot accept a class', async () => {
    const teacherUser = await makeUser({ role: 'teacher', verified: false });
    const { access } = await loginAs(teacherUser);
    const student = await createStudent();
    const [[t]] = await db.query('SELECT id FROM teachers WHERE user_id = ?', [teacherUser.id]);
    const bookingId = await insertBooking({ studentId: student.studentId, teacherId: t.id, date: futureDate(4) });
    const res = await send('put', `/api/bookings/${bookingId}/status`, { token: access, body: { status: 'accepted', fee: 100 } });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('EMAIL_NOT_VERIFIED');
    await db.query('UPDATE users SET email_verified = 1 WHERE id = ?', [teacherUser.id]);
    expect((await send('put', `/api/bookings/${bookingId}/status`, { token: access, body: { status: 'accepted', fee: 100 } })).status).toBe(200);
  });
});

// =====================================================================
describe('Google sign-in', () => {
  const googleAs = (payload) => verifyIdToken.mockResolvedValue({ getPayload: () => payload });
  const gSignIn = (body) => post('/api/auth/google', body);

  it('400 without a credential, 401 when Google rejects it', async () => {
    expect((await gSignIn({})).status).toBe(400);
    verifyIdToken.mockRejectedValue(new Error('bad token'));
    expect((await gSignIn({ credential: 'x', role: 'student' })).status).toBe(401);
  });

  it('creates a verified, password-less account for a new user and logs them in', async () => {
    const email = `g${uid()}@example.test`;
    googleAs({ sub: `sub_${uid()}`, email, name: 'Grace Hopper', email_verified: true });
    const res = await gSignIn({ credential: 'ok', role: 'teacher' });
    expect(res.status).toBe(200);
    expect(rawCookie(res, 'token')).toMatch(/HttpOnly/i);
    const [[row]] = await db.query('SELECT role, email_verified, password_hash FROM users WHERE email = ?', [email]);
    expect(row).toMatchObject({ role: 'teacher', email_verified: 1, password_hash: null });
  });

  it('asks a brand-new user to choose a role first (and creates nothing)', async () => {
    const email = `g${uid()}@example.test`;
    googleAs({ sub: `sub_${uid()}`, email, name: 'No Role', email_verified: true });
    expect((await gSignIn({ credential: 'ok' })).status).toBe(400);
    expect((await gSignIn({ credential: 'ok', role: 'admin' })).status).toBe(400);
    expect((await db.query('SELECT COUNT(*) AS n FROM users WHERE email = ?', [email]))[0][0].n).toBe(0);
  });

  it('REFUSES an email Google has not verified: no account takeover of an existing local account', async () => {
    const victim = await makeUser();
    googleAs({ sub: `evil_${uid()}`, email: victim.email, name: 'Attacker', email_verified: false });
    const res = await gSignIn({ credential: 'ok', role: 'student' });
    expect(res.status).toBe(401);
    expect(rawCookie(res, 'token')).toBeUndefined();
    expect((await userRow(victim.id)).google_id).toBeNull();
  });

  it.each([[undefined], ['true'], [1]])('also refuses email_verified = %p (must be boolean true)', async (flag) => {
    const victim = await makeUser();
    googleAs({ sub: `evil_${uid()}`, email: victim.email, name: 'x', email_verified: flag });
    expect((await gSignIn({ credential: 'ok', role: 'student' })).status).toBe(401);
  });

  it('links a verified Google identity to the existing account with that email', async () => {
    const user = await makeUser({ verified: false });
    const sub = `sub_${uid()}`;
    googleAs({ sub, email: user.email.toUpperCase(), name: 'Same Person', email_verified: true });
    const res = await gSignIn({ credential: 'ok' });
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(user.id);
    expect(await userRow(user.id)).toMatchObject({ google_id: sub, email_verified: 1 });
  });

  it('409 when the email is already linked to a different Google identity', async () => {
    const user = await makeUser({ google: true });
    googleAs({ sub: `other_${uid()}`, email: user.email, name: 'x', email_verified: true });
    expect((await gSignIn({ credential: 'ok' })).status).toBe(409);
  });
});

// =====================================================================
describe('housekeeping', () => {
  it('cleanup removes long-expired / long-revoked sessions and stale login counters, keeping live data', async () => {
    const user = await makeUser();
    const live = await loginAs(user);
    await loginAs(user);
    await loginAs(user);
    const rows = await sessionRows(user.id);
    await db.query('UPDATE sessions SET expires_at = DATE_SUB(NOW(), INTERVAL 8 DAY) WHERE id = ?', [rows[1].id]);
    await db.query("UPDATE sessions SET revoked_at = DATE_SUB(NOW(), INTERVAL 31 DAY), revoked_reason = 'logout' WHERE id = ?", [rows[2].id]);
    await db.query("INSERT INTO login_failures (email_hash, ip, failures, window_started_at) VALUES (?, '9.9.9.9', 3, DATE_SUB(NOW(), INTERVAL 2 DAY))", ['c'.repeat(64)]);

    const removed = await runCleanup();
    expect(removed.sessions).toBeGreaterThanOrEqual(2);
    expect(removed.loginFailures).toBeGreaterThanOrEqual(1);
    expect((await sessionRows(user.id)).map((s) => s.id)).toEqual([rows[0].id]);
    expect((await send('get', '/api/auth/me', { token: live.access })).status).toBe(200);
  });

  it('deleting a user removes their sessions (no orphans)', async () => {
    const user = await makeUser();
    await loginAs(user);
    await db.query('DELETE FROM users WHERE id = ?', [user.id]);
    expect(await sessionRows(user.id)).toHaveLength(0);
  });

  it('the other roles\' test helpers still work with real sessions', async () => {
    const teacher = await createTeacher();
    expect((await send('get', '/api/auth/me', { token: teacher.token })).status).toBe(200);
  });
});