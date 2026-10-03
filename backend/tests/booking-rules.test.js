const r = require('../lib/booking-rules');

// 2026-10-02 10:00 UTC == 15:30 IST (Friday)
const NOW = new Date('2026-10-02T10:00:00Z');

describe('normalizeSlot / slotToMinutes', () => {
  it.each([
    ['9:00 AM', '9:00 AM'], ['9:00am', '9:00 AM'], ['09:00 AM', '9:00 AM'],
    [' 12:30 pm ', '12:30 PM'], ['11:59 PM', '11:59 PM'],
  ])('normalises %j -> %j', (input, out) => expect(r.normalizeSlot(input)).toBe(out));

  it.each(['', '13:00 PM', '9:60 AM', '0:30 AM', '9 AM', 'noon', null, undefined, 900])(
    'rejects %j', (v) => expect(r.normalizeSlot(v)).toBeNull());

  it('converts to minutes since midnight', () => {
    expect(r.slotToMinutes('12:00 AM')).toBe(0);
    expect(r.slotToMinutes('12:00 PM')).toBe(720);
    expect(r.slotToMinutes('5:30 PM')).toBe(17 * 60 + 30);
  });
});

describe('isValidDateString', () => {
  it.each(['2026-10-02', '2028-02-29'])('accepts %s', (d) => expect(r.isValidDateString(d)).toBe(true));
  it.each(['2026-02-31', '2027-02-29', '2026-13-01', '02-10-2026', '2026-1-2', '', null, 20261002])(
    'rejects %j', (d) => expect(r.isValidDateString(d)).toBe(false));
});

describe('timezone handling (APP_TIMEZONE = Asia/Kolkata)', () => {
  it('"today" is evaluated in IST, not UTC', () => {
    // 20:00 UTC on Oct 2 is already 01:30 on Oct 3 in IST
    expect(r.todayInTz(new Date('2026-10-02T20:00:00Z'))).toBe('2026-10-03');
    expect(r.todayInTz(NOW)).toBe('2026-10-02');
  });
  it('isInPast compares date and slot in IST', () => {
    expect(r.isInPast('2026-10-02', '3:00 PM', NOW)).toBe(true);   // 15:00 < 15:30
    expect(r.isInPast('2026-10-02', '5:00 PM', NOW)).toBe(false);
    expect(r.isInPast('2026-10-01', '11:00 PM', NOW)).toBe(true);
    expect(r.isInPast('2026-10-03', '9:00 AM', NOW)).toBe(false);
  });
  it('minutesUntil handles same-day, next-day and past', () => {
    expect(r.minutesUntil('2026-10-02', '5:00 PM', NOW)).toBe(90);
    expect(r.minutesUntil('2026-10-03', '9:00 AM', NOW)).toBe(1440 + 540 - 930);
    expect(r.minutesUntil('2026-10-02', '3:00 PM', NOW)).toBe(-30);
    expect(r.minutesUntil('bad', '3:00 PM', NOW)).toBeNull();
  });
  it('addDays and weekdayOf are timezone independent and cross month/year ends', () => {
    expect(r.addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(r.addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(r.weekdayOf('2026-10-02')).toBe('Fri');
  });
});

describe('parseDays / occurrenceDates', () => {
  it('parses, de-duplicates and canonicalises', () => expect(r.parseDays('mon, WED ,Mon')).toEqual(['Mon', 'Wed']));
  it.each(['', 'Funday', 'Mon,Xyz', null, 3])('rejects %j', (v) => expect(r.parseDays(v)).toBeNull());

  it('demo = single date', () => {
    expect(r.occurrenceDates({ type: 'demo', booking_date: '2026-10-05' })).toEqual(['2026-10-05']);
  });
  it('recurring = matching weekdays for 8 weeks starting on the start date', () => {
    const d = r.occurrenceDates({ type: 'recurring', booking_date: '2026-10-05', days_per_week: 'Mon,Wed' });
    expect(d).toHaveLength(16);
    expect(d[0]).toBe('2026-10-05');
    expect(d.every((x) => ['Mon', 'Wed'].includes(r.weekdayOf(x)))).toBe(true);
  });
});

describe('bookingsConflict', () => {
  const demo = (date, time) => ({ type: 'demo', booking_date: date, booking_time: time });
  it('same date + same slot conflicts, even with different formatting', () => {
    expect(r.bookingsConflict(demo('2026-10-05', '5:00 PM'), demo('2026-10-05', '5:00pm'))).toBe(true);
  });
  it('different slot or different date does not conflict', () => {
    expect(r.bookingsConflict(demo('2026-10-05', '5:00 PM'), demo('2026-10-05', '7:00 PM'))).toBe(false);
    expect(r.bookingsConflict(demo('2026-10-05', '5:00 PM'), demo('2026-10-06', '5:00 PM'))).toBe(false);
  });
  it('a recurring booking conflicts with a demo on one of its weekdays only', () => {
    const rec = { type: 'recurring', booking_date: '2026-10-05', booking_time: '5:00 PM', days_per_week: 'Mon' };
    expect(r.bookingsConflict(rec, demo('2026-10-12', '5:00 PM'))).toBe(true);   // next Monday
    expect(r.bookingsConflict(rec, demo('2026-10-13', '5:00 PM'))).toBe(false);  // Tuesday
    expect(r.bookingsConflict(rec, demo('2027-03-01', '5:00 PM'))).toBe(false);  // after the 8-week window
  });
  it('unparseable times never conflict (and never throw)', () => {
    expect(r.bookingsConflict(demo('2026-10-05', 'x'), demo('2026-10-05', 'x'))).toBe(false);
  });
});

describe('status transitions', () => {
  it('teacher', () => {
    const t = r.TEACHER_TRANSITIONS;
    expect(r.canTransition(t, 'requested', 'accepted')).toBe(true);
    expect(r.canTransition(t, 'requested', 'declined')).toBe(true);
    expect(r.canTransition(t, 'accepted', 'completed')).toBe(true);
    expect(r.canTransition(t, 'accepted', 'cancelled')).toBe(true);
    for (const from of ['declined', 'completed', 'cancelled']) {
      for (const to of ['accepted', 'declined', 'completed', 'cancelled']) expect(r.canTransition(t, from, to)).toBe(false);
    }
    expect(r.canTransition(t, 'requested', 'completed')).toBe(false);
    expect(r.canTransition(t, 'accepted', 'accepted')).toBe(false);
  });
  it('student can only cancel active bookings', () => {
    const s = r.STUDENT_TRANSITIONS;
    expect(r.canTransition(s, 'requested', 'cancelled')).toBe(true);
    expect(r.canTransition(s, 'accepted', 'cancelled')).toBe(true);
    expect(r.canTransition(s, 'completed', 'cancelled')).toBe(false);
    expect(r.canTransition(s, 'requested', 'accepted')).toBe(false);
  });
});

describe('validateNewBooking', () => {
  const ok = { teacher_id: 3, booking_date: '2026-10-05', booking_time: '5:00 pm' };
  it('normalises a valid demo request and defaults type/subject', () => {
    expect(r.validateNewBooking(ok, NOW)).toEqual({
      ok: true,
      value: { teacher_id: 3, type: 'demo', subject: 'General', booking_date: '2026-10-05', booking_time: '5:00 PM', days_per_week: null },
    });
  });
  it('never carries a fee through', () => {
    expect(r.validateNewBooking({ ...ok, fee: 1 }, NOW).value).not.toHaveProperty('fee');
  });
  it('requires weekdays for recurring and canonicalises them', () => {
    expect(r.validateNewBooking({ ...ok, type: 'recurring' }, NOW).ok).toBe(false);
    expect(r.validateNewBooking({ ...ok, type: 'recurring', days_per_week: 'wed,mon' }, NOW).value.days_per_week).toBe('Wed,Mon');
  });
  it('rejects past, far-future and malformed input, and non-object bodies', () => {
    expect(r.validateNewBooking({ ...ok, booking_date: '2026-10-01' }, NOW).code).toBe('SLOT_IN_PAST');
    expect(r.validateNewBooking({ ...ok, booking_date: '2027-12-01' }, NOW).ok).toBe(false);
    expect(r.validateNewBooking({ ...ok, teacher_id: '3; DROP TABLE' }, NOW).ok).toBe(false);
    expect(r.validateNewBooking({ ...ok, teacher_id: 1.5 }, NOW).ok).toBe(false);
    expect(r.validateNewBooking({ ...ok, subject: { a: 1 } }, NOW).ok).toBe(false);
    expect(r.validateNewBooking(null, NOW).ok).toBe(false);
    expect(r.validateNewBooking('x', NOW).ok).toBe(false);
  });
});

describe('teacherSlotList', () => {
  it('canonicalises and de-duplicates a teacher list', () => {
    expect(r.teacherSlotList('9:00am, 11:00 AM ,9:00 AM,junk')).toEqual(['9:00 AM', '11:00 AM']);
  });
  it('falls back to defaults when empty/null', () => {
    expect(r.teacherSlotList(null)).toEqual(r.DEFAULT_SLOTS);
    expect(r.teacherSlotList('junk')).toEqual(r.DEFAULT_SLOTS);
  });
});