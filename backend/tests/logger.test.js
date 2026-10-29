const logger = require('../lib/logger');

describe('logger', () => {
  let lines;
  const saved = { NODE_ENV: process.env.NODE_ENV, LOG_LEVEL: process.env.LOG_LEVEL };

  function restore(key) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }

  beforeEach(() => {
    lines = [];
    logger._setWriter((level, line) => lines.push({ level, line }));
    process.env.NODE_ENV = 'production'; // production output is one JSON object per line
    process.env.LOG_LEVEL = 'debug';
  });

  afterEach(() => {
    logger._setWriter(null);
    restore('NODE_ENV');
    restore('LOG_LEVEL');
  });

  const last = () => JSON.parse(lines[lines.length - 1].line);

  it('writes one JSON object per line in production', () => {
    logger.info('Booking created', { bookingId: 12 });
    expect(lines).toHaveLength(1);
    const rec = last();
    expect(rec.level).toBe('info');
    expect(rec.msg).toBe('Booking created');
    expect(rec.bookingId).toBe(12);
    expect(typeof rec.time).toBe('string');
  });

  it('redacts fields whose names look like secrets', () => {
    logger.info('login', {
      email: 'a@b.com',
      password: 'hunter2',
      nested: { accessToken: 'abc', ok: 1 },
      razorpay_signature: 'sig',
      cookie: 'c=1',
      authorization: 'Bearer xyz',
    });
    const rec = last();
    expect(rec.email).toBe('a@b.com');
    expect(rec.password).toBe('[REDACTED]');
    expect(rec.nested.accessToken).toBe('[REDACTED]');
    expect(rec.nested.ok).toBe(1);
    expect(rec.razorpay_signature).toBe('[REDACTED]');
    expect(rec.cookie).toBe('[REDACTED]');
    expect(rec.authorization).toBe('[REDACTED]');
  });

  it('never logs SQL text or the values inside duplicate-entry messages', () => {
    const err = new Error("Duplicate entry 'a@b.com' for key 'users.email'");
    err.code = 'ER_DUP_ENTRY';
    err.sql = 'SELECT * FROM users WHERE email = "a@b.com"';
    err.sqlMessage = "Duplicate entry 'a@b.com' for key 'users.email'";
    logger.error('db failed', { err });
    const text = lines[0].line;
    expect(text).not.toContain('a@b.com');
    expect(text).not.toContain('SELECT');
    expect(text).toContain('ER_DUP_ENTRY');
    expect(text).toContain('Duplicate entry [REDACTED] for key');
  });

  it('redacts bearer tokens and JWTs that appear inside message text', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJpZCI6MX0.abcdefghijk';
    logger.warn(`failed with Bearer abc.def.ghi and ${jwt}`);
    const text = lines[0].line;
    expect(text).not.toContain('abc.def.ghi');
    expect(text).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(text).toContain('Bearer [REDACTED]');
  });

  it('respects LOG_LEVEL', () => {
    process.env.LOG_LEVEL = 'warn';
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    expect(lines.map((l) => l.level)).toEqual(['warn', 'error']);
  });

  it('stays silent under test unless LOG_LEVEL is set', () => {
    process.env.NODE_ENV = 'test';
    delete process.env.LOG_LEVEL;
    logger.error('should not appear');
    expect(lines).toHaveLength(0);
  });

  it('attaches the request context (request id, user id) to every line', () => {
    logger.runWithContext({ requestId: 'req-12345678' }, () => {
      logger.info('first');
      logger.setContext({ userId: 7 });
      logger.info('second');
    });
    expect(JSON.parse(lines[0].line).requestId).toBe('req-12345678');
    expect(JSON.parse(lines[0].line).userId).toBeUndefined();
    expect(JSON.parse(lines[1].line).userId).toBe(7);
    logger.info('outside');
    expect(JSON.parse(lines[2].line).requestId).toBeUndefined();
  });

  it('does not let fields overwrite time, level or msg', () => {
    logger.info('real message', { level: 'fake', msg: 'fake', time: 'fake' });
    const rec = last();
    expect(rec.level).toBe('info');
    expect(rec.msg).toBe('real message');
    expect(rec.time).not.toBe('fake');
  });

  it('includes a stack trace outside production only', () => {
    const err = new Error('boom');
    logger.error('x', { err });
    expect(last().err.stack).toBeUndefined();

    process.env.NODE_ENV = 'development';
    logger.error('x', { err });
    expect(lines[1].line).toContain('boom');
    expect(lines[1].line).toContain('stack');
  });

  it('truncates very long messages', () => {
    logger.info('x'.repeat(5000));
    expect(last().msg.length).toBeLessThan(2100);
  });

  it('never throws, even if the output stream fails', () => {
    logger._setWriter(() => { throw new Error('disk full'); });
    expect(() => logger.error('still fine')).not.toThrow();
  });

  it('redact() handles circular-looking depth, buffers and arrays safely', () => {
    const deep = { a: { b: { c: { d: { e: 1 } } } } };
    expect(JSON.stringify(logger.redact(deep))).toContain('[Object]');
    expect(logger.redact(Buffer.from('abc'))).toBe('[Buffer 3 bytes]');
    expect(logger.redact([{ token: 't' }])).toEqual([{ token: '[REDACTED]' }]);
  });
});