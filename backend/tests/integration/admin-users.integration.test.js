// Admin user management: list/search users, suspend (blocks login + kills sessions), reactivate.
const request = require('supertest');
const bcrypt = require('bcryptjs');
const app = require('../../server');
const { drain } = require('../../lib/after-response');
const { db, auth, createStudent, createTeacher, createAdmin } = require('./helpers');

afterAll(async () => {
  await drain();
  await db.end();
});

const PASSWORD = 'Str0ng!Passw0rd';

describe('admin user management', () => {
  let admin;
  beforeAll(async () => { admin = await createAdmin(); });

  it('non-admins cannot list or suspend users', async () => {
    const student = await createStudent();
    expect((await request(app).get('/api/admin/users').set(auth(student.token))).status).toBe(403);
    expect((await request(app).post(`/api/admin/users/${student.userId}/suspend`).set(auth(student.token)).send({ reason: 'x' })).status).toBe(403);
  });

  it('lists users with filters, search and pagination metadata', async () => {
    const teacher = await createTeacher({ name: 'Zebra Findme Teacher' });
    const res = await request(app).get('/api/admin/users?role=teacher&q=Findme').set(auth(admin.token));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ page: 1, pageSize: 25 });
    expect(res.body.users.map((u) => u.id)).toContain(teacher.userId);
    expect(res.body.users.every((u) => u.role === 'teacher')).toBe(true);
    expect(JSON.stringify(res.body)).not.toMatch(/password_hash/);
    expect((await request(app).get('/api/admin/users?role=root').set(auth(admin.token))).status).toBe(400);
  });

  it('treats % and _ in the search box literally', async () => {
    const res = await request(app).get('/api/admin/users?q=%25').set(auth(admin.token));
    expect(res.status).toBe(200);
    expect(res.body.users.every((u) => /%/.test(`${u.name}${u.email}${u.phone}`))).toBe(true);
  });

  it('suspending ends sessions, blocks login and hides the teacher; reactivating restores login', async () => {
    const teacher = await createTeacher();
    const [[u]] = await db.query('SELECT email FROM users WHERE id = ?', [teacher.userId]);
    await db.query('UPDATE users SET password_hash = ? WHERE id = ?', [await bcrypt.hash(PASSWORD, 4), teacher.userId]);

    expect((await request(app).get('/api/auth/me').set(auth(teacher.token))).status).toBe(200);
    expect((await request(app).post(`/api/admin/users/${teacher.userId}/suspend`).set(auth(admin.token)).send({})).status).toBe(400);

    const suspend = await request(app).post(`/api/admin/users/${teacher.userId}/suspend`).set(auth(admin.token)).send({ reason: 'Fake documents' });
    expect(suspend.status).toBe(200);
    expect((await request(app).post(`/api/admin/users/${teacher.userId}/suspend`).set(auth(admin.token)).send({ reason: 'again' })).status).toBe(409);

    expect((await request(app).get('/api/auth/me').set(auth(teacher.token))).status).toBe(401);
    const login = await request(app).post('/api/auth/login').send({ email: u.email, password: PASSWORD });
    expect(login.status).toBe(403);
    expect(login.body.code).toBe('ACCOUNT_SUSPENDED');
    const wrong = await request(app).post('/api/auth/login').send({ email: u.email, password: 'Wr0ng!Passw0rd' });
    expect(wrong.status).toBe(401);

    const profile = await request(app).get(`/api/teachers/${teacher.teacherId}`);
    expect(profile.status).toBe(404);

    const list = await request(app).get('/api/admin/users?status=suspended').set(auth(admin.token));
    expect(list.body.users.find((x) => x.id === teacher.userId)).toMatchObject({ suspended_reason: 'Fake documents' });

    expect((await request(app).post(`/api/admin/users/${teacher.userId}/reactivate`).set(auth(admin.token))).status).toBe(200);
    expect((await request(app).post('/api/auth/login').send({ email: u.email, password: PASSWORD })).status).toBe(200);
  });

  it('cannot suspend yourself, another admin, or a missing user', async () => {
    const other = await createAdmin();
    const post = (id) => request(app).post(`/api/admin/users/${id}/suspend`).set(auth(admin.token)).send({ reason: 'x' });
    expect((await post(admin.userId)).status).toBe(400);
    expect((await post(other.userId)).status).toBe(403);
    expect((await post(99999999)).status).toBe(404);
  });
});
