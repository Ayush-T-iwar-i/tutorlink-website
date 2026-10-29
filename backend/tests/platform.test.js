// Runs the request-context middleware inside a real Express app (no database needed).
const request = require('supertest');
const express = require('express');
const { requestContext, bindLogContext, apiNotFound, errorHandler } = require('../middleware/request-context');

function buildApp() {
  const app = express();
  app.use(requestContext);
  app.use(express.json({ limit: '1kb' }));
  app.use(bindLogContext);

  app.get('/api/ok', (req, res) => res.json({ ok: true }));
  app.get('/api/forbidden', (req, res) => res.status(403).json({ error: 'Not allowed.' }));
  app.post('/api/echo', (req, res) => res.json(req.body));
  app.get('/api/boom', () => { throw new Error('SELECT * FROM users WHERE password = 1'); });

  app.use('/api', apiNotFound);
  app.use(errorHandler);
  return app;
}

describe('platform: request ids and uniform errors', () => {
  const app = buildApp();

  it('sets X-Request-Id on success responses', async () => {
    const res = await request(app).get('/api/ok');
    expect(res.status).toBe(200);
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body).toEqual({ ok: true });
  });

  it('echoes a valid caller-supplied request id and replaces an invalid one', async () => {
    const good = await request(app).get('/api/ok').set('X-Request-Id', 'client-req-12345');
    expect(good.headers['x-request-id']).toBe('client-req-12345');

    const bad = await request(app).get('/api/ok').set('X-Request-Id', 'short');
    expect(bad.headers['x-request-id']).not.toBe('short');
  });

  it('errors from routes use the uniform shape and the body id equals the header id', async () => {
    const res = await request(app).get('/api/forbidden');
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe('Not allowed.');
    expect(res.body.error).toBe('Not allowed.');
    expect(res.body.code).toBe('FORBIDDEN');
    expect(res.body.requestId).toBe(res.headers['x-request-id']);
  });

  it('unknown API routes return a uniform JSON 404', async () => {
    const res = await request(app).get('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
    expect(res.body.success).toBe(false);
  });

  it('malformed JSON returns 400 BAD_JSON', async () => {
    const res = await request(app).post('/api/echo').set('Content-Type', 'application/json').send('{"broken":');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BAD_JSON');
  });

  it('an oversized body returns 413 PAYLOAD_TOO_LARGE', async () => {
    const res = await request(app).post('/api/echo').send({ big: 'x'.repeat(5000) });
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('an unexpected exception returns a generic 500 with no SQL or stack trace', async () => {
    const res = await request(app).get('/api/boom');
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(res.body)).not.toContain('SELECT');
    expect(JSON.stringify(res.body)).not.toContain('password');
    expect(res.body.requestId).toBe(res.headers['x-request-id']);
  });
});