/**
 * Web Push: shows a notification on the person's phone/laptop (even when the site is closed).
 * Needs three env vars (see .env.example). When they are missing, push is simply switched off and
 * everything else keeps working. Sending never throws: failures are logged and dead devices removed.
 */
const crypto = require('crypto');
const webpush = require('web-push');
const db = require('../config/db');

const PUBLIC_KEY = (process.env.VAPID_PUBLIC_KEY || '').trim();
const PRIVATE_KEY = (process.env.VAPID_PRIVATE_KEY || '').trim();
const SUBJECT = (process.env.VAPID_SUBJECT || '').trim();

let enabled = false;
if (PUBLIC_KEY && PRIVATE_KEY && SUBJECT) {
  try {
    webpush.setVapidDetails(SUBJECT, PUBLIC_KEY, PRIVATE_KEY);
    enabled = true;
  } catch (err) {
    console.error('Web push disabled: invalid VAPID settings:', err.message);
  }
}

const isEnabled = () => enabled;
const getPublicKey = () => (enabled ? PUBLIC_KEY : null);
const hashEndpoint = (endpoint) => crypto.createHash('sha256').update(endpoint).digest('hex');

function clip(text, max) {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** Save (or move to this user) one device subscription. */
async function saveSubscription(userId, sub, userAgent) {
  await db.query(
    `INSERT INTO push_subscriptions (user_id, endpoint_hash, endpoint, p256dh, auth, user_agent)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), p256dh = VALUES(p256dh), auth = VALUES(auth), user_agent = VALUES(user_agent)`,
    [userId, hashEndpoint(sub.endpoint), sub.endpoint, sub.keys.p256dh, sub.keys.auth, clip(userAgent, 250) || null]
  );
}

async function removeSubscription(userId, endpoint) {
  await db.query('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint_hash = ?', [userId, hashEndpoint(endpoint)]);
}

/**
 * Send one notification to every device of a user. payload: { title, body, url, tag }.
 * Safe to call without await.
 */
async function sendPushToUser(userId, payload) {
  if (!enabled || !userId) return;
  try {
    const [subs] = await db.query(
      'SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?',
      [userId]
    );
    if (!subs.length) return;
    const body = JSON.stringify({
      title: clip(payload.title || 'GharTutor', 60),
      body: clip(payload.body, 140),
      url: payload.url || 'index.html',
      tag: payload.tag || undefined,
    });
    await Promise.all(subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          body,
          { TTL: 60 * 60 * 24, urgency: 'high' }
        );
      } catch (err) {
        if (err && (err.statusCode === 404 || err.statusCode === 410)) {
          await db.query('DELETE FROM push_subscriptions WHERE id = ?', [s.id]).catch(() => {});
        } else {
          console.error('Push send failed:', err && (err.statusCode || err.message));
        }
      }
    }));
  } catch (err) {
    console.error('Push error:', err && err.message);
  }
}

module.exports = { isEnabled, getPublicKey, saveSubscription, removeSubscription, sendPushToUser, hashEndpoint, clip };