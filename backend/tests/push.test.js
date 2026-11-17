const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');

jest.mock('web-push', () => ({ setVapidDetails: jest.fn(), sendNotification: jest.fn() }));
jest.mock('../config/db', () => ({ query: jest.fn() }));

process.env.JWT_SECRET = 'test_secret';
process.env.VAPID_PUBLIC_KEY = 'pub-key';
process.env.VAPID_PRIVATE_KEY = 'priv-key';
process.env.VAPID_SUBJECT = 'mailto:test@example.com';

const db = require('../config/db');
const webpush = require('web-push');
const push = require('../lib/push');
const pushRoutes = require('../routes/push.routes');

const token = (id = 7) => jwt.sign({ id, role: 'teacher' }, process.env.JWT_SECRET, { expiresIn: '1h' });
const goodSub = { endpoint: 'https://push.example.com/abc', keys: { p256dh: 'p', auth: 'a' } };
function app() { const a = express(); a.use(express.json()); a.use('/api/push', pushRoutes); return a; }

beforeEach(() => { db.query.mockReset(); webpush.sendNotification.mockReset(); });

describe('lib/push', () => {
  test('is enabled when the three VAPID settings exist and passes them to web-push', () => {
    expect(push.isEnabled()).toBe(true);
    expect(push.getPublicKey()).toBe('pub-key');
    expect(webpush.setVapidDetails).toHaveBeenCalledWith('mailto:test@example.com', 'pub-key', 'priv-key');
  });

  test('sends to every device of the user with a trimmed payload', async () => {
    db.query.mockResolvedValueOnce([[
      { id: 1, endpoint: 'https://a', p256dh: 'p1', auth: 'a1' },
      { id: 2, endpoint: 'https://b', p256dh: 'p2', auth: 'a2' },
    ]]);
    webpush.sendNotification.mockResolvedValue({});
    await push.sendPushToUser(5, { title: 'Riya', body: 'x'.repeat(300), url: 'teacher-dashboard.html?chat=9', tag: 'chat-9' });
    expect(webpush.sendNotification).toHaveBeenCalledTimes(2);
    const [sub, body] = webpush.sendNotification.mock.calls[0];
    expect(sub).toEqual({ endpoint: 'https://a', keys: { p256dh: 'p1', auth: 'a1' } });
    const parsed = JSON.parse(body);
    expect(parsed.title).toBe('Riya');
    expect(parsed.body.length).toBeLessThanOrEqual(140);
    expect(parsed.url).toBe('teacher-dashboard.html?chat=9');
    expect(parsed.tag).toBe('chat-9');
  });

  test('removes a device that the push service says is gone (410) and does not throw', async () => {
    db.query.mockResolvedValueOnce([[{ id: 3, endpoint: 'https://c', p256dh: 'p', auth: 'a' }]]).mockResolvedValue([{}]);
    webpush.sendNotification.mockRejectedValue(Object.assign(new Error('gone'), { statusCode: 410 }));
    await expect(push.sendPushToUser(5, { body: 'hi' })).resolves.toBeUndefined();
    expect(db.query).toHaveBeenCalledWith('DELETE FROM push_subscriptions WHERE id = ?', [3]);
  });

  test('keeps the device on other errors and never throws', async () => {
    db.query.mockResolvedValueOnce([[{ id: 4, endpoint: 'https://d', p256dh: 'p', auth: 'a' }]]);
    webpush.sendNotification.mockRejectedValue(Object.assign(new Error('boom'), { statusCode: 500 }));
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(push.sendPushToUser(5, { body: 'hi' })).resolves.toBeUndefined();
    expect(db.query).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  test('does nothing when the user has no devices', async () => {
    db.query.mockResolvedValueOnce([[]]);
    await push.sendPushToUser(5, { body: 'hi' });
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });

  test('a database error is swallowed', async () => {
    db.query.mockRejectedValueOnce(new Error('db down'));
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(push.sendPushToUser(5, { body: 'hi' })).resolves.toBeUndefined();
    spy.mockRestore();
  });
});

describe('push routes', () => {
  test('public key is available without login', async () => {
    const res = await request(app()).get('/api/push/public-key');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: true, publicKey: 'pub-key' });
  });

  test('subscribe needs login', async () => {
    expect((await request(app()).post('/api/push/subscribe').send(goodSub)).status).toBe(401);
  });

  test('subscribe saves a valid subscription for the logged-in user', async () => {
    db.query.mockResolvedValue([{}]);
    const res = await request(app()).post('/api/push/subscribe').set('Authorization', `Bearer ${token(7)}`).send(goodSub);
    expect(res.status).toBe(201);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO push_subscriptions/);
    expect(params[0]).toBe(7);
    expect(params[2]).toBe(goodSub.endpoint);
  });

  test.each([
    ['http endpoint', { endpoint: 'http://x.com/a', keys: { p256dh: 'p', auth: 'a' } }],
    ['missing keys', { endpoint: 'https://x.com/a' }],
    ['empty body', {}],
  ])('subscribe rejects %s', async (_n, body) => {
    const res = await request(app()).post('/api/push/subscribe').set('Authorization', `Bearer ${token()}`).send(body);
    expect(res.status).toBe(400);
    expect(db.query).not.toHaveBeenCalled();
  });

  test('unsubscribe removes only this user\'s device', async () => {
    db.query.mockResolvedValue([{}]);
    const res = await request(app()).post('/api/push/unsubscribe').set('Authorization', `Bearer ${token(7)}`).send({ endpoint: goodSub.endpoint });
    expect(res.status).toBe(200);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/DELETE FROM push_subscriptions WHERE user_id = \? AND endpoint_hash = \?/);
    expect(params[0]).toBe(7);
  });
});