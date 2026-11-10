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

describe('upload content sniffing', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { sniffFileType, verifyRealFileType } = require('../middleware/upload.middleware');
  const pad = (bytes) => Buffer.concat([Buffer.from(bytes), Buffer.alloc(16)]);

  it('recognises only the accepted formats', () => {
    expect(sniffFileType(pad([0xff, 0xd8, 0xff, 0xe0]))).toEqual({ mime: 'image/jpeg', ext: '.jpg' });
    expect(sniffFileType(pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toEqual({ mime: 'image/png', ext: '.png' });
    expect(sniffFileType(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toEqual({ mime: 'image/webp', ext: '.webp' });
    expect(sniffFileType(Buffer.from('%PDF-1.7\n%\xe2\xe3'))).toEqual({ mime: 'application/pdf', ext: '.pdf' });
    expect(sniffFileType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">'))).toBeNull();
    expect(sniffFileType(Buffer.from('RIFF\0\0\0\0AVI LIST'))).toBeNull();
    expect(sniffFileType(Buffer.from([0xff, 0xd8]))).toBeNull();
  });

  function runMiddleware(kind, file) {
    return new Promise((resolve) => {
      const res = { status(code) { this.code = code; return this; }, json(body) { resolve({ code: this.code, body }); } };
      verifyRealFileType(kind)({ file }, res, () => resolve({ next: true }));
    });
  }

  it('renames a file to the extension of its real content', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-upload-'));
    const filePath = path.join(dir, '7_photo_1.webp');
    fs.writeFileSync(filePath, pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const file = { fieldname: 'photo', path: filePath, filename: '7_photo_1.webp' };

    await expect(runMiddleware('photo', file)).resolves.toEqual({ next: true });
    expect(file.filename).toBe('7_photo_1.png');
    expect(fs.existsSync(path.join(dir, '7_photo_1.png'))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rejects and deletes a PDF sent as a profile photo', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-upload-'));
    const filePath = path.join(dir, '7_photo_1.jpg');
    fs.writeFileSync(filePath, Buffer.from('%PDF-1.4 not an image'));

    const result = await runMiddleware('photo', { fieldname: 'photo', path: filePath, filename: '7_photo_1.jpg' });
    expect(result.code).toBe(400);
    expect(fs.existsSync(filePath)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
