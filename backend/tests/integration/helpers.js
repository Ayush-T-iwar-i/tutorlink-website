const jwt = require('jsonwebtoken');
const db = require('../../config/db');
const rules = require('../../lib/booking-rules');

let counter = 0;
const uniq = () => `${process.pid}${Date.now() % 100000}${++counter}`;

function tokenFor(userId, role) {
  return jwt.sign({ id: userId, role }, process.env.JWT_SECRET, { expiresIn: '1h' });
}
const auth = (token) => ({ Authorization: `Bearer ${token}` });

async function createUser(role, overrides = {}) {
  const n = uniq();
  const [r] = await db.query(
    `INSERT INTO users (name, email, phone, password_hash, role, email_verified)
     VALUES (?, ?, ?, 'x', ?, 1)`,
    [overrides.name || `${role} ${n}`, `${role}${n}@example.test`, `9${String(n).padStart(9, '0').slice(-9)}`, role]
  );
  return r.insertId;
}

async function createStudent(overrides = {}) {
  const userId = await createUser('student', overrides);
  const [r] = await db.query('INSERT INTO students (user_id) VALUES (?)', [userId]);
  return { userId, studentId: r.insertId, token: tokenFor(userId, 'student') };
}

async function createTeacher({ approved = true, slots = null, ...overrides } = {}) {
  const userId = await createUser('teacher', overrides);
  const [r] = await db.query(
    `INSERT INTO teachers (user_id, subjects, fee_per_hour, available_slots, verification_status)
     VALUES (?, 'Maths', 300, ?, ?)`,
    [userId, slots, approved ? 'approved' : 'pending']
  );
  return { userId, teacherId: r.insertId, token: tokenFor(userId, 'teacher') };
}

/** A date `n` days from today in the app timezone. */
const futureDate = (n = 3) => rules.addDays(rules.todayInTz(), n);
const pastDate = (n = 3) => rules.addDays(rules.todayInTz(), -n);

async function insertBooking({ studentId, teacherId, status = 'requested', type = 'demo', date, time = '5:00 PM', days = null, fee = 0, payment = 'unpaid' }) {
  const [r] = await db.query(
    `INSERT INTO bookings (student_id, teacher_id, type, subject, booking_date, booking_time, days_per_week, status, fee, payment_status)
     VALUES (?, ?, ?, 'Maths', ?, ?, ?, ?, ?, ?)`,
    [studentId, teacherId, type, date, time, days, status, fee, payment]
  );
  return r.insertId;
}

module.exports = { db, tokenFor, auth, createStudent, createTeacher, futureDate, pastDate, insertBooking };