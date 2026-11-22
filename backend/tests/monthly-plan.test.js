const rules = require('../lib/booking-rules');

describe('monthly plans', () => {
  const base = { type: 'recurring', booking_date: '2027-01-04', days_per_week: 'Mon,Wed' };
  const now = new Date('2026-11-20');
  const v = (x) => rules.validateNewBooking({ teacher_id: 1, type: 'recurring', booking_date: '2027-01-04', booking_time: '5:00 PM', days_per_week: 'Mon', ...x }, now);

  test('legacy bookings stay 8 weeks (16 sessions)', () => {
    expect(rules.occurrenceDates(base)).toHaveLength(16);
  });
  test('plan length controls session count', () => {
    expect(rules.occurrenceDates({ ...base, duration_months: 1 })).toHaveLength(8);
    expect(rules.occurrenceDates({ ...base, duration_months: 6 })).toHaveLength(48);
  });
  test('weeksFor falls back to 8 for invalid values', () => {
    expect(rules.weeksFor(5)).toBe(8);
    expect(rules.weeksFor(null)).toBe(8);
    expect(rules.weeksFor(3)).toBe(12);
  });
  test('planEndDate', () => {
    expect(rules.planEndDate({ ...base, duration_months: 1 })).toBe('2027-01-31');
    expect(rules.planEndDate({ type: 'demo', booking_date: '2027-01-04' })).toBeNull();
  });
  test('conflicts respect plan length', () => {
    const demo = { type: 'demo', booking_date: '2027-05-10', booking_time: '5:00 PM' };
    expect(rules.bookingsConflict({ ...base, booking_time: '5:00 PM', duration_months: 6 }, demo)).toBe(true);
    expect(rules.bookingsConflict({ ...base, booking_time: '5:00 PM', duration_months: 1 }, demo)).toBe(false);
  });
  test('validation of duration_months and from_booking_id', () => {
    expect(v({ duration_months: '4' }).value.duration_months).toBe(4);
    expect(v({ duration_months: 5 }).ok).toBe(false);
    expect(v({ duration_months: 0 }).ok).toBe(false);
    expect(v({ from_booking_id: '9' }).value.from_booking_id).toBe(9);
    expect(v({ from_booking_id: 'abc' }).ok).toBe(false);
  });
  test('demo ignores duration_months', () => {
    const r = rules.validateNewBooking({ teacher_id: 1, type: 'demo', booking_date: '2027-01-04', booking_time: '5:00 PM', duration_months: 3 }, now);
    expect(r.value.duration_months).toBeNull();
  });
});