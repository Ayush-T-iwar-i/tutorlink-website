const { EventEmitter } = require('events');
const multer = require('multer');
const logger = require('../lib/logger');
const mw = require('../middleware/request-context');

function fakeReq(overrides = {}) {
  const headers = overrides.headers || {};
  return {
    method: 'GET',
    originalUrl: '/api/things?token=super-secret-token',
    ip: '203.0.113.9',
    get: (name) => headers[String(name).toLowerCase()],
    ...overrides,
  };
}

function fakeRes() {
  const res = new EventEmitter();
  res.statusCode = 200;
  res.headers = {};
  res.headersSent = false;
  res.body = undefined;
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

describe('request context middleware', () => {
  let lines;
  const saved = { NODE_ENV: process.env.NODE_ENV, LOG_LEVEL: process.env.LOG_LEVEL };

  function restore(key) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }

  beforeEach(() => {
    lines = [];
    logger._setWriter((level, line) => lines.push({ level, line }));
    process.env.NODE_ENV = 'production';
    process.env.LOG_LEVEL = 'debug';
  });

  afterEach(() => {
    logger._setWriter(null);
    restore('NODE_ENV');
    restore('LOG_LEVEL');
  });

  // Runs requestContext on a fresh fake request/response and returns them.
  function start(reqOverrides) {
    const req = fakeReq(reqOverrides);
    const res = fakeRes();
    let nextCalled = false;
    mw.requestContext(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
    return { req, res };
  }

  describe('request id', () => {
    it('generates an id, exposes it as req.id and sets X-Request-Id', () => {
      const { req, res } = start();
      expect(req.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(res.headers['x-request-id']).toBe(req.id);
    });

    it('accepts a valid id supplied by the caller', () => {
      const { req, res } = start({ headers: { 'x-request-id': 'client-id_12345.abc' } });
      expect(req.id).toBe('client-id_12345.abc');
      expect(res.headers['x-request-id']).toBe('client-id_12345.abc');
    });

    it('ignores a supplied id that is too short, too long or has odd characters', () => {
      for (const bad of ['abc', 'x'.repeat(65), 'has space in it', 'inject\r\nHeader: 1', '<script>alert(1)</script>']) {
        const { req } = start({ headers: { 'x-request-id': bad } });
        expect(req.id).not.toBe(bad);
        expect(req.id).toMatch(/^[0-9a-f-]{36}$/);
      }
    });
  });

  describe('uniform error responses', () => {
    it('gives every error the same shape and keeps the route-supplied code', () => {
      const { req, res } = start();
      res.status(401).json({ error: 'Not logged in.', code: 'NO_TOKEN' });
      expect(res.body).toEqual({
        success: false,
        message: 'Not logged in.',
        error: 'Not logged in.',
        code: 'NO_TOKEN',
        requestId: req.id,
      });
    });

    it('fills in a default code from the status when the route gave none', () => {
      const cases = { 400: 'BAD_REQUEST', 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'CONFLICT', 422: 'VALIDATION_ERROR', 423: 'LOCKED', 429: 'RATE_LIMITED', 500: 'INTERNAL_ERROR', 503: 'SERVICE_UNAVAILABLE' };
      for (const [status, code] of Object.entries(cases)) {
        const { res } = start();
        res.status(Number(status)).json({ error: 'x' });
        expect(res.body.code).toBe(code);
      }
    });

    it('accepts a body that only has message, or neither', () => {
      let { res } = start();
      res.status(400).json({ message: 'Only message' });
      expect(res.body.error).toBe('Only message');
      expect(res.body.message).toBe('Only message');

      ({ res } = start());
      res.status(500).json({});
      expect(res.body.message).toBe('Something went wrong on our end.');
      expect(res.body.code).toBe('INTERNAL_ERROR');
    });

    it('keeps extra fields added by the route', () => {
      const { res } = start();
      res.status(502).json({ error: 'Gateway problem', code: 'GATEWAY_ERROR', refund: 'started' });
      expect(res.body.refund).toBe('started');
      expect(res.body.success).toBe(false);
    });

    it('leaves success responses and arrays untouched', () => {
      let { res } = start();
      res.status(200).json({ ok: true });
      expect(res.body).toEqual({ ok: true });

      ({ res } = start());
      res.status(201).json([1, 2, 3]);
      expect(res.body).toEqual([1, 2, 3]);

      ({ res } = start());
      res.status(400).json(['a']);
      expect(res.body).toEqual(['a']);
    });
  });

  describe('request log', () => {
    const logged = () => lines.map((l) => JSON.parse(l.line));

    it('logs method, path, status, duration and ip, without the query string', () => {
      const { req, res } = start();
      res.status(200).json({ ok: true });
      res.emit('finish');
      expect(lines).toHaveLength(1);
      const rec = logged()[0];
      expect(rec.msg).toBe('request');
      expect(rec.method).toBe('GET');
      expect(rec.path).toBe('/api/things');
      expect(rec.status).toBe(200);
      expect(rec.requestId).toBe(req.id);
      expect(rec.ip).toBe('203.0.113.9');
      expect(typeof rec.durationMs).toBe('number');
      expect(lines[0].line).not.toContain('super-secret-token');
    });

    it('uses the route pattern instead of the real path when the route is known', () => {
      const { res } = start({ originalUrl: '/api/bookings/42', baseUrl: '/api/bookings', route: { path: '/:id' } });
      res.emit('finish');
      expect(logged()[0].path).toBe('/api/bookings/:id');
    });

    it('includes the user id once authentication has set it', () => {
      const { req, res } = start();
      req.user = { id: 55 };
      res.emit('finish');
      expect(logged()[0].userId).toBe(55);
    });

    it('uses warn for 4xx and error for 5xx', () => {
      let { res } = start();
      res.status(404).json({ error: 'x' });
      res.emit('finish');
      ({ res } = start());
      res.status(500).json({ error: 'x' });
      res.emit('finish');
      expect(lines.map((l) => l.level)).toEqual(['warn', 'error']);
    });

    it('does not log /health or successful static files', () => {
      let { res } = start({ originalUrl: '/health' });
      res.emit('finish');
      ({ res } = start({ originalUrl: '/css/style.css' }));
      res.emit('finish');
      expect(lines).toHaveLength(0);
    });

    it('does log a failed static request', () => {
      const { res } = start({ originalUrl: '/missing.png' });
      res.status(404).json({ error: 'x' });
      res.emit('finish');
      expect(lines).toHaveLength(1);
    });
  });

  describe('bindLogContext', () => {
    it('puts the request id on log lines written while the request is handled', () => {
      mw.bindLogContext({ id: 'abcd1234-ctx' }, {}, () => {
        logger.info('inside handler');
      });
      expect(JSON.parse(lines[0].line).requestId).toBe('abcd1234-ctx');
    });
  });

  describe('apiNotFound', () => {
    it('returns a uniform 404', () => {
      const { req, res } = start();
      mw.apiNotFound(req, res);
      expect(res.statusCode).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
      expect(res.body.success).toBe(false);
      expect(res.body.requestId).toBe(req.id);
    });
  });

  describe('errorHandler', () => {
    function handle(err) {
      const { req, res } = start();
      let passedOn = null;
      mw.errorHandler(err, req, res, (e) => { passedOn = e; });
      return { req, res, passedOn };
    }

    it('turns malformed JSON into 400 BAD_JSON', () => {
      const err = Object.assign(new SyntaxError('Unexpected token'), { type: 'entity.parse.failed' });
      const { res } = handle(err);
      expect(res.statusCode).toBe(400);
      expect(res.body.code).toBe('BAD_JSON');
    });

    it('turns an oversized body into 413', () => {
      const err = Object.assign(new Error('too large'), { type: 'entity.too.large', status: 413 });
      const { res } = handle(err);
      expect(res.statusCode).toBe(413);
      expect(res.body.code).toBe('PAYLOAD_TOO_LARGE');
    });

    it('turns an unsupported encoding into 415', () => {
      const err = Object.assign(new Error('x'), { type: 'encoding.unsupported' });
      expect(handle(err).res.statusCode).toBe(415);
    });

    it('turns multer errors into clear 400s', () => {
      let { res } = handle(new multer.MulterError('LIMIT_FILE_SIZE'));
      expect(res.statusCode).toBe(400);
      expect(res.body.code).toBe('FILE_TOO_LARGE');
      expect(res.body.message).toMatch(/too large/i);

      ({ res } = handle(new multer.MulterError('LIMIT_UNEXPECTED_FILE')));
      expect(res.statusCode).toBe(400);
      expect(res.body.code).toBe('UPLOAD_ERROR');
    });

    it('turns a rejected file type into 400 INVALID_FILE_TYPE', () => {
      const { res } = handle(new Error('Only JPG, PNG, WEBP and PDF files are allowed.'));
      expect(res.statusCode).toBe(400);
      expect(res.body.code).toBe('INVALID_FILE_TYPE');
    });

    it('keeps the status of a client error raised by a library, and hides its message unless exposed', () => {
      let { res } = handle(Object.assign(new Error('internal detail'), { status: 404 }));
      expect(res.statusCode).toBe(404);
      expect(res.body.message).not.toContain('internal detail');

      ({ res } = handle(Object.assign(new Error('Safe to show'), { status: 404, expose: true })));
      expect(res.body.message).toBe('Safe to show');
    });

    it('returns a generic 500 and never leaks the error text, SQL or a stack trace', () => {
      const err = new Error('SELECT * FROM users WHERE password = "x"');
      err.sql = 'SELECT * FROM users';
      const { res } = handle(err);
      expect(res.statusCode).toBe(500);
      expect(res.body.code).toBe('INTERNAL_ERROR');
      expect(JSON.stringify(res.body)).not.toContain('SELECT');
      expect(JSON.stringify(res.body)).not.toContain('stack');
      expect(res.body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('shows the real message in development only', () => {
      process.env.NODE_ENV = 'development';
      const { res } = handle(new Error('details for the developer'));
      expect(res.body.message).toBe('details for the developer');
    });

    it('logs unexpected errors with the request id but without SQL', () => {
      const err = new Error('boom');
      err.sql = 'SELECT secret FROM t';
      const { req } = handle(err);
      const errorLines = lines.filter((l) => l.level === 'error');
      expect(errorLines).toHaveLength(1);
      expect(errorLines[0].line).toContain('Unhandled error');
      expect(errorLines[0].line).toContain(req.id);
      expect(errorLines[0].line).not.toContain('SELECT');
    });

    it('does not log expected client errors as unhandled', () => {
      handle(Object.assign(new SyntaxError('x'), { type: 'entity.parse.failed' }));
      expect(lines.filter((l) => l.level === 'error')).toHaveLength(0);
    });

    it('hands over to Express when the response has already started', () => {
      const { req, res } = start();
      res.headersSent = true;
      let passedOn = null;
      const err = new Error('late');
      mw.errorHandler(err, req, res, (e) => { passedOn = e; });
      expect(passedOn).toBe(err);
      expect(res.body).toBeUndefined();
    });
  });
});