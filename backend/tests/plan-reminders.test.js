jest.mock('node-cron', () => ({ schedule: jest.fn() }));
jest.mock('../config/db', () => ({ query: jest.fn() }));
jest.mock('../routes/notification.routes', () => ({ createNotification: jest.fn().mockResolvedValue() }));

const db = require('../config/db');
const { createNotification } = require('../routes/notification.routes');
const { sendPlanEndingReminders } = require('../jobs/plan-reminders');

const NOW = new Date('2027-01-28T06:00:00Z'); // 28 Jan 2027, 11:30 IST
const plan = (over) => ({
  id: 1, subject: 'Maths', booking_date: '2027-01-04', duration_months: 1,
  student_user_id: 10, student_name: 'Riya', teacher_user_id: 20, teacher_name: 'Anita', ...over,
});

beforeEach(() => {
  db.query.mockReset();
  createNotification.mockClear();
});

describe('sendPlanEndingReminders', () => {
  test('reminds student and teacher once for a plan ending within 3 days', async () => {
    // 1 month from 2027-01-04 ends 2027-01-31 (3 days away)
    db.query.mockResolvedValueOnce([[plan()]]).mockResolvedValueOnce([{ affectedRows: 1 }]);
    const sent = await sendPlanEndingReminders(NOW);
    expect(sent).toBe(1);
    expect(createNotification).toHaveBeenCalledTimes(2);
    expect(createNotification.mock.calls[0][0]).toBe(10);
    expect(createNotification.mock.calls[0][1]).toContain('2027-01-31');
    expect(createNotification.mock.calls[1][0]).toBe(20);
  });

  test('skips plans that end later or already ended', async () => {
    db.query.mockResolvedValueOnce([[plan({ duration_months: 2 }), plan({ id: 2, booking_date: '2026-11-01' })]]);
    expect(await sendPlanEndingReminders(NOW)).toBe(0);
    expect(createNotification).not.toHaveBeenCalled();
    expect(db.query).toHaveBeenCalledTimes(1); // nothing was claimed
  });

  test('does not notify when another run already claimed the plan', async () => {
    db.query.mockResolvedValueOnce([[plan()]]).mockResolvedValueOnce([{ affectedRows: 0 }]);
    expect(await sendPlanEndingReminders(NOW)).toBe(0);
    expect(createNotification).not.toHaveBeenCalled();
  });

  test('never throws when the database fails', async () => {
    db.query.mockRejectedValueOnce(new Error('db down'));
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(sendPlanEndingReminders(NOW)).resolves.toBe(0);
    console.error.mockRestore();
  });
});
