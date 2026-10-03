const request = require('supertest');
const app = require('../../server');
const { drain } = require('../../lib/after-response');
const {
  db, auth, createStudent, createTeacher, futureDate, pastDate, insertBooking,
} = require('./helpers');

afterAll(async () => {
  await drain();
  await db.end();
});

const book = (student, body) =>
  request(app).post('/api/bookings').set(auth(student.token)).send(body);

const validBody = (teacher, extra = {}) => ({
  teacher_id: teacher.teacherId,
  type: 'demo',
  subject: 'Maths',
  booking_date: futureDate(3),
  booking_time: '5:00 PM',
  ...extra,
});

describe('POST /api/bookings — auth & validation', () => {
  let student, teacher;
  beforeAll(async () => {
    student = await createStudent();
    teacher = await createTeacher();
  });

  it('401 without a token', async () => {
    const res = await request(app).post('/api/bookings').send(validBody(teacher));
    expect(res.status).toBe(401);
  });

  it('403 for a teacher token', async () => {
    const res = await request(app).post('/api/bookings').set(auth(teacher.token)).send(validBody(teacher));
    expect(res.status).toBe(403);
  });

  it.each([
    ['missing teacher_id', { teacher_id: undefined }],
    ['non-numeric teacher_id', { teacher_id: 'abc' }],
    ['missing date', { booking_date: undefined }],
    ['impossible date', { booking_date: '2026-02-31' }],
    ['malformed time', { booking_time: '25:99' }],
    ['unknown type', { type: 'weekly' }],
    ['recurring without days', { type: 'recurring' }],
    ['recurring with bad day', { type: 'recurring', days_per_week: 'Mon,Funday' }],
    ['over-long subject', { subject: 'x'.repeat(101) }],
  ])('400 for %s', async (_name, patch) => {
    const res = await book(student, validBody(teacher, patch));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('400 for a date in the past', async () => {
    const res = await book(student, validBody(teacher, { booking_date: pastDate(2) }));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('SLOT_IN_PAST');
  });

  it('404 for an unknown teacher', async () => {
    const res = await book(student, validBody(teacher, { teacher_id: 99999999 }));
    expect(res.status).toBe(404);
  });

  it('404 for a teacher who is not approved', async () => {
    const pending = await createTeacher({ approved: false });
    const res = await book(student, validBody(pending));
    expect(res.status).toBe(404);
  });

  it('400 when the teacher does not offer that slot', async () => {
    const t = await createTeacher({ slots: '9:00 AM,11:00 AM' });
    const res = await book(student, validBody(t, { booking_time: '5:00 PM' }));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('SLOT_NOT_OFFERED');
  });

  it('ignores a student-supplied fee (fee is always 0 until the teacher accepts)', async () => {
    const t = await createTeacher();
    const res = await book(student, validBody(t, { fee: 1 }));
    expect(res.status).toBe(201);
    const [[row]] = await db.query('SELECT fee, status FROM bookings WHERE id = ?', [res.body.booking_id]);
    expect(Number(row.fee)).toBe(0);
    expect(row.status).toBe('requested');
  });
});

describe('booking happy path & visibility', () => {
  it('both parties see the booking, DATE columns are plain strings, internals are hidden', async () => {
    const student = await createStudent();
    const teacher = await createTeacher();
    const date = futureDate(4);
    const res = await book(student, validBody(teacher, { booking_date: date, booking_time: '3:00 pm' }));
    expect(res.status).toBe(201);

    const mine = await request(app).get('/api/bookings/student/me').set(auth(student.token));
    const row = mine.body.find((b) => b.id === res.body.booking_id);
    expect(row.booking_date).toBe(date);
    expect(row.booking_time).toBe('3:00 PM'); // normalised
    expect(row).not.toHaveProperty('slot_key');

    const theirs = await request(app).get('/api/bookings/teacher/me').set(auth(teacher.token));
    expect(theirs.body.some((b) => b.id === res.body.booking_id)).toBe(true);
    expect(theirs.body[0]).not.toHaveProperty('slot_key');
  });
});

describe('conflict detection', () => {
  it('rejects a duplicate request from the same student (409 DUPLICATE_BOOKING)', async () => {
    const s = await createStudent();
    const t = await createTeacher();
    const body = validBody(t);
    expect((await book(s, body)).status).toBe(201);
    const again = await book(s, body);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('DUPLICATE_BOOKING');
  });

  it('rejects another student taking the same slot (409 SLOT_TAKEN) but allows a different slot', async () => {
    const [a, b] = [await createStudent(), await createStudent()];
    const t = await createTeacher();
    expect((await book(a, validBody(t))).status).toBe(201);
    const clash = await book(b, validBody(t));
    expect(clash.status).toBe(409);
    expect(clash.body.code).toBe('SLOT_TAKEN');
    expect((await book(b, validBody(t, { booking_time: '7:00 PM' }))).status).toBe(201);
  });

  it('stops a student being double-booked across two teachers (409 STUDENT_BUSY)', async () => {
    const s = await createStudent();
    const [t1, t2] = [await createTeacher(), await createTeacher()];
    expect((await book(s, validBody(t1))).status).toBe(201);
    const res = await book(s, validBody(t2));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('STUDENT_BUSY');
  });

  it('frees the slot again once the booking is cancelled', async () => {
    const [a, b] = [await createStudent(), await createStudent()];
    const t = await createTeacher();
    const first = await book(a, validBody(t));
    await request(app).put(`/api/bookings/${first.body.booking_id}/cancel`).set(auth(a.token)).expect(200);
    expect((await book(b, validBody(t))).status).toBe(201);
  });

  it('a recurring booking blocks every matching weekday in its window, not only the start date', async () => {
    const t = await createTeacher();
    const s1 = await createStudent();
    const s2 = await createStudent();
    const start = futureDate(3);
    // Recurring every day of the week at 5 PM => every date conflicts.
    const rec = await book(s1, validBody(t, { type: 'recurring', booking_date: start, days_per_week: 'Sun,Mon,Tue,Wed,Thu,Fri,Sat' }));
    expect(rec.status).toBe(201);
    const later = await book(s2, validBody(t, { booking_date: futureDate(10) }));
    expect(later.status).toBe(409);
    expect(later.body.code).toBe('SLOT_TAKEN');
    // A different time on the same date is fine.
    expect((await book(s2, validBody(t, { booking_date: futureDate(10), booking_time: '9:00 AM' }))).status).toBe(201);
  });

  it('availability endpoint marks the taken slot unavailable', async () => {
    const s = await createStudent();
    const viewer = await createStudent();
    const t = await createTeacher();
    const date = futureDate(5);
    await book(s, validBody(t, { booking_date: date, booking_time: '1:00 PM' }));
    const res = await request(app).get(`/api/bookings/availability/${t.teacherId}?date=${date}`).set(auth(viewer.token));
    expect(res.status).toBe(200);
    expect(res.body.slots.find((x) => x.slot === '1:00 PM').available).toBe(false);
    expect(res.body.slots.find((x) => x.slot === '3:00 PM').available).toBe(true);
    expect(JSON.stringify(res.body)).not.toMatch(/student|email/i);
  });
});

describe('concurrency', () => {
  it('8 students racing for the same slot: exactly one wins, the rest get 409', async () => {
    const t = await createTeacher();
    const students = await Promise.all(Array.from({ length: 8 }, () => createStudent()));
    const date = futureDate(6);
    const results = await Promise.all(
      students.map((s) => book(s, validBody(t, { booking_date: date, booking_time: '11:00 AM' })))
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((x) => x === 201)).toHaveLength(1);
    expect(statuses.filter((x) => x === 409)).toHaveLength(7);
    const [[{ n }]] = await db.query(
      `SELECT COUNT(*) AS n FROM bookings WHERE teacher_id = ? AND booking_date = ? AND booking_time = '11:00 AM'`,
      [t.teacherId, date]
    );
    expect(n).toBe(1);
  });

  it('one student double/quintuple-clicking creates exactly one booking', async () => {
    const s = await createStudent();
    const t = await createTeacher();
    const body = validBody(t, { booking_date: futureDate(7) });
    const results = await Promise.all(Array.from({ length: 5 }, () => book(s, body)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    const [[{ n }]] = await db.query('SELECT COUNT(*) AS n FROM bookings WHERE student_id = ?', [s.studentId]);
    expect(n).toBe(1);
  });

  it('the database itself refuses a duplicate active slot even if the app check were bypassed', async () => {
    const [a, b] = [await createStudent(), await createStudent()];
    const t = await createTeacher();
    const date = futureDate(8);
    await insertBooking({ studentId: a.studentId, teacherId: t.teacherId, date });
    await expect(insertBooking({ studentId: b.studentId, teacherId: t.teacherId, date }))
      .rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });
    // ...but a cancelled booking does not hold the slot
    await insertBooking({ studentId: b.studentId, teacherId: t.teacherId, date, status: 'cancelled' });
  });
});

describe('PUT /api/bookings/:id/status — teacher actions', () => {
  let student, teacher, other;
  beforeEach(async () => {
    student = await createStudent();
    teacher = await createTeacher();
    other = await createTeacher();
  });

  const put = (id, tok, body) => request(app).put(`/api/bookings/${id}/status`).set(auth(tok)).send(body);
  const create = async (extra) => (await book(student, validBody(teacher, extra))).body.booking_id;

  it.each([
    ['no fee', {}],
    ['fee "abc"', { fee: 'abc' }],
    ['negative fee', { fee: -5 }],
    ['absurd fee', { fee: 1e9 }],
    ['null fee', { fee: null }],
  ])('400 when accepting with %s', async (_n, extra) => {
    const id = await create();
    const res = await put(id, teacher.token, { status: 'accepted', ...extra });
    expect(res.status).toBe(400);
  });

  it('accept sets the fee and creates the session, enrollment and course together', async () => {
    const id = await create();
    const res = await put(id, teacher.token, { status: 'accepted', fee: '350.555' });
    expect(res.status).toBe(200);
    const [[b]] = await db.query('SELECT status, fee FROM bookings WHERE id = ?', [id]);
    expect(b.status).toBe('accepted');
    expect(Number(b.fee)).toBeCloseTo(350.56, 2);
    const [[{ s }]] = await db.query('SELECT COUNT(*) AS s FROM class_sessions WHERE booking_id = ?', [id]);
    const [[{ e }]] = await db.query('SELECT COUNT(*) AS e FROM enrollments WHERE booking_id = ?', [id]);
    const [[{ c }]] = await db.query('SELECT COUNT(*) AS c FROM courses c JOIN enrollments e ON e.id = c.enrollment_id WHERE e.booking_id = ?', [id]);
    expect([s, e, c]).toEqual([1, 1, 1]);
  });

  it('a recurring accept creates one session per matching weekday, on the right dates', async () => {
    const start = futureDate(3);
    const id = await create({ type: 'recurring', booking_date: start, days_per_week: 'Mon,Thu' });
    expect((await put(id, teacher.token, { status: 'accepted', fee: 200 })).status).toBe(200);
    const [rows] = await db.query('SELECT session_date FROM class_sessions WHERE booking_id = ? ORDER BY session_date', [id]);
    const rules = require('../../lib/booking-rules');
    expect(rows.map((r) => r.session_date)).toEqual(
      rules.occurrenceDates({ type: 'recurring', booking_date: start, days_per_week: 'Mon,Thu' })
    );
    expect(rows.every((r) => ['Mon', 'Thu'].includes(rules.weekdayOf(r.session_date)))).toBe(true);
  });

  it('is atomic: if creating the course fails, nothing from the accept is kept', async () => {
    const id = await create();
    await db.query('RENAME TABLE courses TO courses_tmp');
    try {
      const res = await put(id, teacher.token, { status: 'accepted', fee: 100 });
      expect(res.status).toBe(500);
    } finally {
      await db.query('RENAME TABLE courses_tmp TO courses');
    }
    const [[b]] = await db.query('SELECT status, fee FROM bookings WHERE id = ?', [id]);
    expect(b.status).toBe('requested');
    expect(Number(b.fee)).toBe(0);
    const [[{ s }]] = await db.query('SELECT COUNT(*) AS s FROM class_sessions WHERE booking_id = ?', [id]);
    const [[{ e }]] = await db.query('SELECT COUNT(*) AS e FROM enrollments WHERE booking_id = ?', [id]);
    expect([s, e]).toEqual([0, 0]);
  });

  it('rejects illegal transitions with 409', async () => {
    const id = await create();
    expect((await put(id, teacher.token, { status: 'completed' })).status).toBe(409);   // requested -> completed
    expect((await put(id, teacher.token, { status: 'declined' })).status).toBe(200);
    expect((await put(id, teacher.token, { status: 'accepted', fee: 100 })).status).toBe(409); // declined -> accepted
    expect((await put(id, teacher.token, { status: 'declined' })).status).toBe(409);
  });

  it('accepting twice does not duplicate sessions or enrollments', async () => {
    const id = await create();
    await put(id, teacher.token, { status: 'accepted', fee: 100 });
    expect((await put(id, teacher.token, { status: 'accepted', fee: 100 })).status).toBe(409);
    const [[{ s }]] = await db.query('SELECT COUNT(*) AS s FROM class_sessions WHERE booking_id = ?', [id]);
    expect(s).toBe(1);
  });

  it('cannot mark a future class completed, but can once it has started', async () => {
    const id = await create();
    await put(id, teacher.token, { status: 'accepted', fee: 100 });
    const early = await put(id, teacher.token, { status: 'completed' });
    expect(early.status).toBe(400);
    expect(early.body.code).toBe('NOT_STARTED');

    const past = await insertBooking({ studentId: student.studentId, teacherId: teacher.teacherId, status: 'accepted', date: pastDate(2) });
    expect((await put(past, teacher.token, { status: 'completed' })).status).toBe(200);
  });

  it('cannot accept a request whose time has already passed', async () => {
    const past = await insertBooking({ studentId: student.studentId, teacherId: teacher.teacherId, date: pastDate(1) });
    const res = await put(past, teacher.token, { status: 'accepted', fee: 100 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('SLOT_IN_PAST');
  });

  it('403 for a teacher who does not own the booking, and for students', async () => {
    const id = await create();
    expect((await put(id, other.token, { status: 'accepted', fee: 100 })).status).toBe(403);
    expect((await put(id, student.token, { status: 'accepted', fee: 100 })).status).toBe(403);
    const [[b]] = await db.query('SELECT status FROM bookings WHERE id = ?', [id]);
    expect(b.status).toBe('requested');
  });

  it('400 for an invalid status or booking id', async () => {
    const id = await create();
    expect((await put(id, teacher.token, { status: 'not_a_real_status' })).status).toBe(400);
    expect((await put('abc', teacher.token, { status: 'declined' })).status).toBe(400);
  });

  it('teacher cancelling a paid accepted booking is flagged needs_refund', async () => {
    const id = await insertBooking({ studentId: student.studentId, teacherId: teacher.teacherId, status: 'accepted', date: futureDate(9), fee: 500, payment: 'paid' });
    const res = await put(id, teacher.token, { status: 'cancelled' });
    expect(res.status).toBe(200);
    expect(res.body.needs_refund).toBe(true);
  });
});

describe('PUT /api/bookings/:id/cancel — student', () => {
  it('cancels own booking once; sessions and enrollment are cancelled too', async () => {
    const s = await createStudent();
    const t = await createTeacher();
    const id = (await book(s, validBody(t))).body.booking_id;
    await request(app).put(`/api/bookings/${id}/status`).set(auth(t.token)).send({ status: 'accepted', fee: 100 }).expect(200);

    const res = await request(app).put(`/api/bookings/${id}/cancel`).set(auth(s.token));
    expect(res.status).toBe(200);
    const [[{ live }]] = await db.query("SELECT COUNT(*) AS live FROM class_sessions WHERE booking_id = ? AND status = 'scheduled'", [id]);
    const [[e]] = await db.query('SELECT status FROM enrollments WHERE booking_id = ?', [id]);
    expect(live).toBe(0);
    expect(e.status).toBe('cancelled');

    expect((await request(app).put(`/api/bookings/${id}/cancel`).set(auth(s.token))).status).toBe(409);
  });

  it("another student cannot cancel someone else's booking (IDOR)", async () => {
    const [owner, intruder] = [await createStudent(), await createStudent()];
    const t = await createTeacher();
    const id = (await book(owner, validBody(t))).body.booking_id;
    const res = await request(app).put(`/api/bookings/${id}/cancel`).set(auth(intruder.token));
    expect(res.status).toBe(403);
    const [[b]] = await db.query('SELECT status FROM bookings WHERE id = ?', [id]);
    expect(b.status).toBe('requested');
  });
});

describe('IDOR on read endpoints', () => {
  it("a non-participant cannot read a booking's sessions", async () => {
    const [owner, intruder] = [await createStudent(), await createStudent()];
    const t = await createTeacher();
    const id = (await book(owner, validBody(t))).body.booking_id;
    expect((await request(app).get(`/api/bookings/${id}/sessions`).set(auth(intruder.token))).status).toBe(403);
    expect((await request(app).get(`/api/bookings/${id}/sessions`).set(auth(owner.token))).status).toBe(200);
  });
});