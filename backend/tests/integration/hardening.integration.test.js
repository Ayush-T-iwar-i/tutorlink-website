// Input-validation and race-condition hardening, checked against real MySQL.
const request = require('supertest');
const app = require('../../server');
const { drain } = require('../../lib/after-response');
const {
  db, auth, createStudent, createTeacher, createAdmin, pastDate, insertBooking,
} = require('./helpers');

afterAll(async () => {
  await drain();
  await db.end();
});

describe('student location & preferences validation', () => {
  let student;
  beforeAll(async () => { student = await createStudent(); });
  const put = (path, body) => request(app).put(`/api/students/${student.userId}/${path}`).set(auth(student.token)).send(body);

  it('rejects out-of-range coordinates with 400 (was a 500 / silent bad data)', async () => {
    const res = await put('location', { city: 'Pune', latitude: 123, longitude: 73 });
    expect(res.status).toBe(400);
  });

  it('rejects over-long fields with 400', async () => {
    const res = await put('location', { city: 'x'.repeat(101) });
    expect(res.status).toBe(400);
  });

  it('stores a valid, trimmed location', async () => {
    const res = await put('location', { address: ' 12 MG Road ', city: 'Pune', pincode: '411001', latitude: 18.52, longitude: 73.85 });
    expect(res.status).toBe(200);
    const [[row]] = await db.query('SELECT address, city, pincode, latitude FROM students WHERE id = ?', [student.studentId]);
    expect(row).toMatchObject({ address: '12 MG Road', city: 'Pune', pincode: '411001' });
    expect(Number(row.latitude)).toBeCloseTo(18.52);
  });

  it('rejects non-text preferences with 400', async () => {
    const res = await put('preferences', { preferred_subjects: { a: 1 } });
    expect(res.status).toBe(400);
  });
});

describe('teacher profile validation', () => {
  it('rejects an absurd fee and an over-long bio', async () => {
    const teacher = await createTeacher();
    const put = (body) => request(app).put(`/api/teachers/${teacher.userId}/profile`).set(auth(teacher.token)).send(body);
    expect((await put({ subjects: 'Maths', fee_per_hour: 5000000 })).status).toBe(400);
    expect((await put({ subjects: 'Maths', bio: 'x'.repeat(2001) })).status).toBe(400);
    expect((await put({ subjects: 'Maths', fee_per_hour: 450, bio: 'Hello' })).status).toBe(200);
  });
});

describe('favorites & reports reject unknown targets instead of crashing', () => {
  let student, teacher;
  beforeAll(async () => {
    student = await createStudent();
    teacher = await createTeacher();
  });

  it('favorite: 404 for a missing teacher, 400 for a non-numeric id, 201 for a real one', async () => {
    const fav = (teacher_id) => request(app).post('/api/favorites').set(auth(student.token)).send({ teacher_id });
    expect((await fav(99999999)).status).toBe(404);
    expect((await fav('abc')).status).toBe(400);
    expect((await fav(teacher.teacherId)).status).toBe(201);
  });

  it('favorite: unapproved teachers cannot be saved', async () => {
    const pending = await createTeacher({ approved: false });
    const res = await request(app).post('/api/favorites').set(auth(student.token)).send({ teacher_id: pending.teacherId });
    expect(res.status).toBe(404);
  });

  it('report: 404 for a missing user, 400 for over-long details', async () => {
    const report = (body) => request(app).post('/api/reports').set(auth(student.token)).send(body);
    expect((await report({ reported_user_id: 99999999, reason: 'other' })).status).toBe(404);
    expect((await report({ reported_user_id: teacher.userId, reason: 'other', details: 'x'.repeat(2001) })).status).toBe(400);
    expect((await report({ reported_user_id: teacher.userId, reason: 'other', details: 'Sent spam' })).status).toBe(201);
  });
});

describe('reviews', () => {
  it('only one review per booking, even when two submits race', async () => {
    const student = await createStudent();
    const teacher = await createTeacher();
    const bookingId = await insertBooking({ studentId: student.studentId, teacherId: teacher.teacherId, status: 'completed', date: pastDate(2) });
    const submit = () => request(app).post('/api/reviews').set(auth(student.token)).send({ booking_id: bookingId, rating: 5 });
    const results = await Promise.all([submit(), submit(), submit()]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409, 409]);
    const [[{ n }]] = await db.query('SELECT COUNT(*) AS n FROM reviews WHERE booking_id = ?', [bookingId]);
    expect(n).toBe(1);
    const [[t]] = await db.query('SELECT total_reviews, rating_avg FROM teachers WHERE id = ?', [teacher.teacherId]);
    expect(t.total_reviews).toBe(1);
    expect(Number(t.rating_avg)).toBe(5);
  });

  it('rejects fractional ratings and over-long comments', async () => {
    const student = await createStudent();
    const teacher = await createTeacher();
    const bookingId = await insertBooking({ studentId: student.studentId, teacherId: teacher.teacherId, status: 'completed', date: pastDate(2) });
    const submit = (body) => request(app).post('/api/reviews').set(auth(student.token)).send({ booking_id: bookingId, ...body });
    expect((await submit({ rating: 4.5 })).status).toBe(400);
    expect((await submit({ rating: 4, comment: 'x'.repeat(2001) })).status).toBe(400);
  });
});

describe('messages', () => {
  it('cannot send new messages on a cancelled booking; non-string message is a 400', async () => {
    const student = await createStudent();
    const teacher = await createTeacher();
    const cancelled = await insertBooking({ studentId: student.studentId, teacherId: teacher.teacherId, status: 'cancelled', date: pastDate(1) });
    const send = (id, message) => request(app).post(`/api/messages/${id}`).set(auth(student.token)).send({ message });
    expect((await send(cancelled, 'hello')).status).toBe(400);
    expect((await send(cancelled, { evil: true })).status).toBe(400);
  });
});

describe('admin reports', () => {
  let admin;
  beforeAll(async () => { admin = await createAdmin(); });

  it('rejects an unknown status filter and 404s on a missing report', async () => {
    expect((await request(app).get('/api/admin/reports?status=bogus').set(auth(admin.token))).status).toBe(400);
    const res = await request(app).put('/api/admin/reports/99999999').set(auth(admin.token)).send({ status: 'resolved' });
    expect(res.status).toBe(404);
  });
});

describe('admin refund claim', () => {
  it('a payment that is no longer "paid" is not re-claimed', async () => {
    const admin = await createAdmin();
    const { insertPayment } = require('./helpers');
    const student = await createStudent();
    const teacher = await createTeacher();
    const bookingId = await insertBooking({ studentId: student.studentId, teacherId: teacher.teacherId, status: 'cancelled', date: pastDate(1), fee: 300 });
    const paymentId = await insertPayment({ bookingId, status: 'refunded' });
    const res = await request(app).post(`/api/admin/payments/${paymentId}/refund`).set(auth(admin.token));
    expect(res.status).toBe(409);
    const [[p]] = await db.query('SELECT status FROM payments WHERE id = ?', [paymentId]);
    expect(p.status).toBe('refunded');
  });
});
