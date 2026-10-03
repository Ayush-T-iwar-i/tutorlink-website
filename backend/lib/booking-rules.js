/**
 * Pure booking business rules — no database, no Express. Everything here is unit-tested
 * in tests/booking-rules.test.js. Routes call these helpers so the rules live in one place.
 *
 * Time model
 *  - Dates are plain 'YYYY-MM-DD' strings, times are canonical 12-hour labels like '5:00 PM'.
 *  - "Today" and "now" are evaluated in APP_TIMEZONE (default Asia/Kolkata) — never in the
 *    server's local timezone — so behaviour is identical on a laptop, in Docker and on a host.
 *  - A class occupies exactly its slot label; class duration is not modelled. Two bookings
 *    conflict when a teacher (or a student) has the same slot label on the same date.
 */

const APP_TIMEZONE = process.env.APP_TIMEZONE || 'Asia/Kolkata';
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const RECURRING_WEEKS = 8;
const MAX_BOOKING_DAYS_AHEAD = 180;

// Used when a teacher has not configured their own availability yet (mirrors the UI default).
const DEFAULT_SLOTS = ['9:00 AM', '11:00 AM', '1:00 PM', '3:00 PM', '5:00 PM', '7:00 PM'];

const SLOT_RE = /^(0?[1-9]|1[0-2]):([0-5]\d)\s*(AM|PM)$/i;

/** '9:00am' / '09:00 AM' -> '9:00 AM'. Returns null if not a valid 12-hour time. */
function normalizeSlot(value) {
  if (typeof value !== 'string') return null;
  const m = value.trim().match(SLOT_RE);
  if (!m) return null;
  return `${parseInt(m[1], 10)}:${m[2]} ${m[3].toUpperCase()}`;
}

/** Minutes since midnight for a canonical slot label, or null. */
function slotToMinutes(slot) {
  const norm = normalizeSlot(slot);
  if (!norm) return null;
  const m = norm.match(SLOT_RE);
  let h = parseInt(m[1], 10) % 12;
  if (m[3].toUpperCase() === 'PM') h += 12;
  return h * 60 + parseInt(m[2], 10);
}

/** Strict 'YYYY-MM-DD' that is also a real calendar date (rejects 2026-02-31). */
function isValidDateString(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, mo, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function partsInTz(now, tz) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const p = Object.fromEntries(fmt.formatToParts(now).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: parseInt(p.hour, 10) * 60 + parseInt(p.minute, 10) };
}

function todayInTz(now = new Date(), tz = APP_TIMEZONE) {
  return partsInTz(now, tz).date;
}

function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

function weekdayOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

/** True when the given date + slot has already started (in APP_TIMEZONE). */
function isInPast(dateStr, slot, now = new Date(), tz = APP_TIMEZONE) {
  const cur = partsInTz(now, tz);
  if (dateStr < cur.date) return true;
  if (dateStr > cur.date) return false;
  const mins = slotToMinutes(slot);
  return mins === null ? false : mins <= cur.minutes;
}

/**
 * Minutes from `now` until the given date + slot starts, evaluated in APP_TIMEZONE.
 * Negative when it has already started. Returns null if the slot is not parseable.
 */
function minutesUntil(dateStr, slot, now = new Date(), tz = APP_TIMEZONE) {
  const mins = slotToMinutes(slot);
  if (mins === null || !isValidDateString(dateStr)) return null;
  const cur = partsInTz(now, tz);
  const toDays = (d) => { const [y, m, dd] = d.split('-').map(Number); return Date.UTC(y, m - 1, dd) / 86400000; };
  return (toDays(dateStr) - toDays(cur.date)) * 1440 + mins - cur.minutes;
}

/** True when a date is further in the future than we allow bookings for. */
function isTooFarAhead(dateStr, now = new Date(), tz = APP_TIMEZONE) {
  return dateStr > addDays(todayInTz(now, tz), MAX_BOOKING_DAYS_AHEAD);
}

/** 'Mon, wed ,Mon' -> ['Mon','Wed'] ; returns null when any entry is not a weekday. */
function parseDays(value) {
  if (typeof value !== 'string') return null;
  const out = [];
  for (const raw of value.split(',')) {
    const t = raw.trim();
    if (!t) continue;
    const day = WEEKDAYS.find((w) => w.toLowerCase() === t.toLowerCase());
    if (!day) return null;
    if (!out.includes(day)) out.push(day);
  }
  return out.length ? out : null;
}

/**
 * Every date a booking occupies. A demo is one date; a recurring booking is every matching
 * weekday from its start date for RECURRING_WEEKS weeks. `booking_date` may be a
 * 'YYYY-MM-DD' string.
 */
function occurrenceDates({ type, booking_date, days_per_week }, weeks = RECURRING_WEEKS) {
  if (!booking_date) return [];
  if (type !== 'recurring') return [booking_date];
  const days = parseDays(days_per_week);
  if (!days) return [booking_date];
  const dates = [];
  for (let i = 0; i < weeks * 7; i++) {
    const d = addDays(booking_date, i);
    if (days.includes(weekdayOf(d))) dates.push(d);
  }
  return dates;
}

/** Do two bookings occupy the same slot on at least one common date? */
function bookingsConflict(a, b) {
  const ta = normalizeSlot(a.booking_time);
  const tb = normalizeSlot(b.booking_time);
  if (!ta || !tb || ta !== tb) return false;
  const setA = new Set(occurrenceDates(a));
  return occurrenceDates(b).some((d) => setA.has(d));
}

/** Teacher's `available_slots` column ('9:00 AM,11:00 AM') -> canonical slot list. */
function teacherSlotList(availableSlots) {
  const list = String(availableSlots || '')
    .split(',')
    .map(normalizeSlot)
    .filter(Boolean);
  return list.length ? [...new Set(list)] : [...DEFAULT_SLOTS];
}

/**
 * Validate and normalise the body of POST /api/bookings.
 * Never reads `fee` — the fee is set by the teacher when accepting, not by the student.
 * Returns { ok: true, value } or { ok: false, error, code }.
 */
function validateNewBooking(input, now = new Date()) {
  const body = input && typeof input === 'object' ? input : {};
  const bad = (error, code = 'VALIDATION_ERROR') => ({ ok: false, error, code });

  const teacherId = Number(body.teacher_id);
  if (!Number.isInteger(teacherId) || teacherId < 1) return bad('A valid teacher_id is required.');

  const type = body.type === undefined || body.type === null || body.type === '' ? 'demo' : body.type;
  if (type !== 'demo' && type !== 'recurring') return bad("Booking type must be 'demo' or 'recurring'.");

  let subject = body.subject === undefined || body.subject === null ? 'General' : body.subject;
  if (typeof subject !== 'string') return bad('Subject must be text.');
  subject = subject.trim() || 'General';
  if (subject.length > 100) return bad('Subject is too long (max 100 characters).');

  if (!isValidDateString(body.booking_date)) return bad('Please choose a valid date (YYYY-MM-DD).');
  const slot = normalizeSlot(body.booking_time);
  if (!slot) return bad("Please choose a valid time slot, e.g. '5:00 PM'.");
  if (isInPast(body.booking_date, slot, now)) return bad('That time has already passed. Please choose a future slot.', 'SLOT_IN_PAST');
  if (isTooFarAhead(body.booking_date, now)) return bad(`Bookings can be made at most ${MAX_BOOKING_DAYS_AHEAD} days ahead.`);

  let days = null;
  if (type === 'recurring') {
    const parsed = parseDays(body.days_per_week);
    if (!parsed) return bad('Choose at least one valid weekday (Mon, Tue, ...) for recurring classes.');
    days = parsed.join(',');
  }

  return {
    ok: true,
    value: { teacher_id: teacherId, type, subject, booking_date: body.booking_date, booking_time: slot, days_per_week: days },
  };
}

// ---------- Status transitions ----------
const TEACHER_TRANSITIONS = {
  requested: ['accepted', 'declined'],
  accepted: ['completed', 'cancelled'],
};
const STUDENT_TRANSITIONS = {
  requested: ['cancelled'],
  accepted: ['cancelled'],
};

function canTransition(table, from, to) {
  return Array.isArray(table[from]) && table[from].includes(to);
}

module.exports = {
  APP_TIMEZONE, WEEKDAYS, RECURRING_WEEKS, MAX_BOOKING_DAYS_AHEAD,
  DEFAULT_SLOTS, teacherSlotList, validateNewBooking,
  normalizeSlot, slotToMinutes, isValidDateString, todayInTz, addDays, weekdayOf,
  isInPast, minutesUntil, isTooFarAhead, parseDays, occurrenceDates, bookingsConflict,
  TEACHER_TRANSITIONS, STUDENT_TRANSITIONS, canTransition,
};