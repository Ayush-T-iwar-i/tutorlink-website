const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');

jest.mock('../config/db', () => ({ query: jest.fn() }));
jest.mock('../routes/notification.routes', () => ({ createNotification: jest.fn().mockResolvedValue() }));

const db = require('../config/db');
const { createNotification } = require('../routes/notification.routes');
process.env.JWT_SECRET = 'test_secret';
const myTuitionRoutes = require('../routes/my-tuition.routes');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/my-tuition', myTuitionRoutes);
  return app;
}

function token(role, userId) {
  return jwt.sign({ id: userId, role }, process.env.JWT_SECRET, { expiresIn: '1h' });
}
const studentAuth = () => ({ Authorization: `Bearer ${token('student', 5)}` });

// What ownedEnrollment() returns for a student's own, active, recurring tuition.
const ENROLLMENT = {
  id: 7, student_id: 3, teacher_id: 4, booking_id: 9, subject: 'Maths', status: 'active',
  start_date: '2026-10-01', end_date: null, booking_type: 'recurring', days_per_week: 3, booking_time: '17:00:00', monthly_fee: '2500.00',
};

let app;
beforeEach(() => {
  db.query.mockReset();
  createNotification.mockReset();
  createNotification.mockResolvedValue();
  app = buildApp();
});

describe('access rules', () => {
  it('needs a login', async () => {
    const res = await request(app).get('/api/my-tuition');
    expect(res.status).toBe(401);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('is closed to teachers', async () => {
    const res = await request(app).get('/api/my-tuition').set('Authorization', `Bearer ${token('teacher', 10)}`);
    expect(res.status).toBe(403);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('answers 404 for an id that is not a positive whole number, without touching the database', async () => {
    const res = await request(app).get('/api/my-tuition/abc/sessions').set(studentAuth());
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
    expect(db.query).not.toHaveBeenCalled();
  });

  it("answers 404 for another student's tuition, exactly like a missing one", async () => {
    db.query.mockResolvedValueOnce([[]]);
    const res = await request(app).get('/api/my-tuition/7/tests').set(studentAuth());
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Tuition not found.');
    // The ownership query is scoped to the logged-in user (user id 5).
    expect(db.query.mock.calls[0][1]).toEqual([7, 5]);
  });
});

describe('GET /api/my-tuition (list)', () => {
  it('returns each tuition with cleaned-up numbers and the next class time', async () => {
    db.query
      .mockResolvedValueOnce([[{
        id: 7, subject: 'Maths', status: 'active', start_date: '2026-10-01', booking_id: 9,
        teacher_name: 'Ananya Sharma', teacher_photo: null, days_per_week: 3, booking_time: '17:00:00',
        classes_attended: '8', classes_absent: '1', next_class_date: '2026-11-20', homework_to_do: '2', avg_test_percent: '76.54',
      }, {
        id: 6, subject: 'Physics', status: 'active', start_date: '2026-09-01', booking_id: 8,
        teacher_name: 'Ravi', teacher_photo: null, days_per_week: 2, booking_time: '10:00:00',
        classes_attended: null, classes_absent: null, next_class_date: null, homework_to_do: null, avg_test_percent: null,
      }]])
      .mockResolvedValueOnce([[{ session_time: '17:00:00' }]]);

    const res = await request(app).get('/api/my-tuition').set(studentAuth());

    expect(res.status).toBe(200);
    expect(res.body.tuitions).toHaveLength(2);
    expect(res.body.tuitions[0]).toMatchObject({
      classes_attended: 8, classes_absent: 1, homework_to_do: 2, avg_test_percent: 76.5, next_class_time: '17:00:00',
    });
    expect(res.body.tuitions[1]).toMatchObject({
      classes_attended: 0, classes_absent: 0, homework_to_do: 0, avg_test_percent: null, next_class_time: null,
    });
    // The second tuition has no next class, so only one extra lookup happened (list + one time lookup).
    expect(db.query).toHaveBeenCalledTimes(2);
    expect(typeof res.body.today).toBe('string');
  });

  it('answers 500 with a safe message when the database fails', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    db.query.mockRejectedValueOnce(new Error('connection lost'));
    const res = await request(app).get('/api/my-tuition').set(studentAuth());
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Could not load your tuition.', code: 'INTERNAL_ERROR' });
    expect(JSON.stringify(res.body)).not.toMatch(/connection lost/);
    spy.mockRestore();
  });
});

describe('GET /api/my-tuition/:id/sessions', () => {
  it('returns an empty list when the tuition has no booking', async () => {
    db.query.mockResolvedValueOnce([[{ ...ENROLLMENT, booking_id: null }]]);
    const res = await request(app).get('/api/my-tuition/7/sessions').set(studentAuth());
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it("never selects the teacher's private class notes", async () => {
    db.query
      .mockResolvedValueOnce([[ENROLLMENT]])
      .mockResolvedValueOnce([[{ id: 1, session_date: '2026-11-03', session_time: '17:00:00', status: 'completed', attendance: 'present', topic: 'Fractions' }]]);
    const res = await request(app).get('/api/my-tuition/7/sessions').set(studentAuth());
    expect(res.status).toBe(200);
    expect(res.body[0].topic).toBe('Fractions');
    const sql = db.query.mock.calls[1][0];
    expect(sql).not.toMatch(/\bnotes\b/i);
    expect(db.query.mock.calls[1][1]).toEqual([9]);
  });
});

describe('GET /api/my-tuition/:id/tests', () => {
  it('turns marks into numbers and keeps unmarked tests as null', async () => {
    db.query
      .mockResolvedValueOnce([[ENROLLMENT]])
      .mockResolvedValueOnce([[
        { id: 2, title: 'Unit test 2', test_date: '2026-11-10', max_marks: '50.00', marks_obtained: null, remarks: null },
        { id: 1, title: 'Unit test 1', test_date: '2026-10-10', max_marks: '50.00', marks_obtained: '41.50', remarks: 'Good' },
      ]]);
    const res = await request(app).get('/api/my-tuition/7/tests').set(studentAuth());
    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({ max_marks: 50, marks_obtained: null });
    expect(res.body[1]).toMatchObject({ max_marks: 50, marks_obtained: 41.5, remarks: 'Good' });
  });
});

describe('GET /api/my-tuition/:id/assignments', () => {
  it('lists only published homework for this enrollment, with this student\'s own submission', async () => {
    db.query
      .mockResolvedValueOnce([[ENROLLMENT]])
      .mockResolvedValueOnce([[{ id: 11, title: 'Worksheet 1', submission_status: null }]]);
    const res = await request(app).get('/api/my-tuition/7/assignments').set(studentAuth());
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    const [sql, params] = db.query.mock.calls[1];
    expect(sql).toMatch(/a\.status = 'published'/);
    expect(params).toEqual([3, 7]); // student id, enrollment id
  });
});

describe('POST /api/my-tuition/:id/assignments/:assignmentId/submit', () => {
  const submit = (body, assignmentId = 11) =>
    request(app).post(`/api/my-tuition/7/assignments/${assignmentId}/submit`).set(studentAuth()).send(body);

  it('rejects an empty or non-text answer', async () => {
    db.query.mockResolvedValue([[ENROLLMENT]]);
    for (const body of [{}, { text: '' }, { text: '   ' }, { text: 123 }]) {
      const res = await submit(body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION');
    }
  });

  it('rejects an answer longer than 3000 characters', async () => {
    db.query.mockResolvedValueOnce([[ENROLLMENT]]);
    const res = await submit({ text: 'a'.repeat(3001) });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/3000/);
  });

  it('rejects hand-ins when the tuition is not active', async () => {
    db.query.mockResolvedValueOnce([[{ ...ENROLLMENT, status: 'completed' }]]);
    const res = await submit({ text: 'My answer' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NOT_ACTIVE');
  });

  it('answers 404 for homework that is not published for this tuition', async () => {
    db.query.mockResolvedValueOnce([[ENROLLMENT]]).mockResolvedValueOnce([[]]);
    const res = await submit({ text: 'My answer' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Homework not found.');
  });

  it('answers 404 for a bad homework id', async () => {
    db.query.mockResolvedValueOnce([[ENROLLMENT]]);
    const res = await submit({ text: 'My answer' }, 'x');
    expect(res.status).toBe(404);
  });

  it('refuses to change homework the teacher has already checked', async () => {
    db.query
      .mockResolvedValueOnce([[ENROLLMENT]])
      .mockResolvedValueOnce([[{ id: 11, title: 'Worksheet 1' }]])
      .mockResolvedValueOnce([[{ id: 50, status: 'reviewed' }]]);
    const res = await submit({ text: 'New answer' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ALREADY_REVIEWED');
    expect(db.query).toHaveBeenCalledTimes(3); // no write happened
  });

  it('inserts a first hand-in, trims the text and notifies the teacher', async () => {
    db.query
      .mockResolvedValueOnce([[ENROLLMENT]])
      .mockResolvedValueOnce([[{ id: 11, title: 'Worksheet 1' }]])
      .mockResolvedValueOnce([[]])                       // no earlier submission
      .mockResolvedValueOnce([{ insertId: 60 }])         // insert
      .mockResolvedValueOnce([[{ user_id: 40 }]]);       // teacher's user id
    const res = await submit({ text: '  My answer  ' });
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Homework handed in.');
    const insert = db.query.mock.calls[3];
    expect(insert[0]).toMatch(/INSERT INTO assignment_submissions/);
    expect(insert[1]).toEqual([11, 3, 'My answer']);
    expect(createNotification).toHaveBeenCalledWith(40, expect.stringContaining('Worksheet 1'), 'teacher-students.html?id=7&tab=homework');
  });

  it('updates an earlier hand-in that has not been checked yet', async () => {
    db.query
      .mockResolvedValueOnce([[ENROLLMENT]])
      .mockResolvedValueOnce([[{ id: 11, title: 'Worksheet 1' }]])
      .mockResolvedValueOnce([[{ id: 50, status: 'submitted' }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([[{ user_id: 40 }]]);
    const res = await submit({ text: 'Better answer' });
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Your answer was updated.');
    const update = db.query.mock.calls[3];
    expect(update[0]).toMatch(/UPDATE assignment_submissions/);
    expect(update[1]).toEqual(['Better answer', 50]);
  });

  it('still succeeds when notifying the teacher fails', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    createNotification.mockRejectedValueOnce(new Error('notify down'));
    db.query
      .mockResolvedValueOnce([[ENROLLMENT]])
      .mockResolvedValueOnce([[{ id: 11, title: 'Worksheet 1' }]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([{ insertId: 60 }])
      .mockResolvedValueOnce([[{ user_id: 40 }]]);
    const res = await submit({ text: 'My answer' });
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Homework handed in.');
    spy.mockRestore();
  });
});