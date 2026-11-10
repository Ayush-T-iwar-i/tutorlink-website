jest.mock('../config/db', () => ({ query: jest.fn() }));
jest.mock('../config/email', () => ({ sendMail: jest.fn() }));
jest.mock('../config/sms', () => ({ sendSms: jest.fn() }));

const db = require('../config/db');
const { sendMail } = require('../config/email');
const validate = require('../lib/validate');
const emailTemplates = require('../config/email-templates');
const { toCsv } = require('../routes/admin.routes');
const { sendDueReminders } = require('../jobs/reminders');
const rules = require('../lib/booking-rules');

describe('lib/validate', () => {
  it('optionalText trims, nulls blanks and enforces type/length', () => {
    expect(validate.optionalText('  hi ', 5, 'X')).toBe('hi');
    expect(validate.optionalText('   ', 5, 'X')).toBeNull();
    expect(validate.optionalText(undefined, 5, 'X')).toBeNull();
    expect(() => validate.optionalText('toolong', 3, 'X')).toThrow(validate.ValidationError);
    expect(() => validate.optionalText(42, 3, 'X')).toThrow(/must be text/);
    expect(() => validate.requiredText('', 3, 'Name')).toThrow(/required/);
  });

  it('optionalCoordinates accepts pairs in range only', () => {
    expect(validate.optionalCoordinates(undefined, '')).toEqual({ lat: null, lng: null });
    expect(validate.optionalCoordinates('18.5', 73.8)).toEqual({ lat: 18.5, lng: 73.8 });
    expect(() => validate.optionalCoordinates(91, 0)).toThrow();
    expect(() => validate.optionalCoordinates(10, undefined)).toThrow();
    expect(() => validate.optionalCoordinates('abc', 10)).toThrow();
  });

  it('positiveId', () => {
    expect(validate.positiveId('7')).toBe(7);
    expect(validate.positiveId(0)).toBeNull();
    expect(validate.positiveId('1.5')).toBeNull();
    expect(validate.positiveId('x')).toBeNull();
  });
});

describe('email templates escape user-supplied text', () => {
  it('HTML in names/subjects is rendered inert', () => {
    const { html } = emailTemplates.newBookingRequest({
      teacherName: '<img src=x onerror=alert(1)>',
      studentName: '<script>bad()</script>',
      subject: 'Maths" onclick="x',
      type: 'demo',
    });
    expect(html).not.toMatch(/<script>|<img/);
    expect(html).toContain('&lt;script&gt;bad()&lt;/script&gt;');
    expect(html).toContain('Maths&quot; onclick=&quot;x');
  });

  it('server-generated links (plain string args) are passed through unchanged', () => {
    const { html } = emailTemplates.emailVerification('https://x.test/verify?token=abc&u=1');
    expect(html).toContain('href="https://x.test/verify?token=abc&u=1"');
  });
});

describe('admin CSV export', () => {
  it('neutralises spreadsheet formulas and escapes quotes', () => {
    const csv = toCsv([{ name: '=HYPERLINK("http://evil")', email: '+1', city: 'Pune "West"' }], ['name', 'email', 'city']);
    const line = csv.split('\n')[1];
    expect(line).toBe(`"'=HYPERLINK(""http://evil"")","'+1","Pune ""West"""`);
  });
});

describe('reminder job claims a session before sending', () => {
  beforeEach(() => jest.clearAllMocks());

  const dueSession = () => {
    const today = rules.todayInTz();
    return { id: 9, session_date: today, session_time: '5:00 PM', booking_id: 1, student_email: 's@x.test', teacher_email: 't@x.test', student_name: 'S', teacher_name: 'T' };
  };

  it('skips sending when another instance already claimed it', async () => {
    jest.spyOn(rules, 'minutesUntil').mockReturnValue(60);
    db.query
      .mockResolvedValueOnce([[dueSession()]])
      .mockResolvedValueOnce([{ affectedRows: 0 }]);
    await sendDueReminders();
    expect(sendMail).not.toHaveBeenCalled();
    expect(db.query.mock.calls[1][0]).toMatch(/reminder_sent = 0/);
  });

  it('sends once when the claim succeeds and releases it if sending throws', async () => {
    jest.spyOn(rules, 'minutesUntil').mockReturnValue(60);
    jest.spyOn(console, 'error').mockImplementation(() => {});
    sendMail.mockRejectedValueOnce(new Error('smtp down'));
    db.query
      .mockResolvedValueOnce([[dueSession()]])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);
    await sendDueReminders();
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(db.query.mock.calls[2][0]).toBe('UPDATE class_sessions SET reminder_sent = 0 WHERE id = ?');
  });
});
