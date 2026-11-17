const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middleware/auth.middleware');
const push = require('../lib/push');

// GET /api/push/public-key  -> { enabled, publicKey }
router.get('/public-key', (req, res) => {
  res.json({ enabled: push.isEnabled(), publicKey: push.getPublicKey() });
});

function validSub(sub) {
  return sub && typeof sub.endpoint === 'string' && /^https:\/\//.test(sub.endpoint) && sub.endpoint.length <= 2000 &&
    sub.keys && typeof sub.keys.p256dh === 'string' && typeof sub.keys.auth === 'string' &&
    sub.keys.p256dh.length <= 255 && sub.keys.auth.length <= 255;
}

// POST /api/push/subscribe   body: PushSubscription JSON
router.post('/subscribe', verifyToken, async (req, res) => {
  try {
    if (!push.isEnabled()) return res.status(503).json({ error: 'Push notifications are not switched on yet.' });
    if (!validSub(req.body)) return res.status(400).json({ error: 'Invalid subscription.' });
    await push.saveSubscription(req.user.id, req.body, req.get('user-agent'));
    res.status(201).json({ message: 'Subscribed.' });
  } catch (err) {
    console.error('Push subscribe error:', err);
    res.status(500).json({ error: 'Could not turn on notifications.' });
  }
});

// POST /api/push/unsubscribe   body: { endpoint }
router.post('/unsubscribe', verifyToken, async (req, res) => {
  try {
    const endpoint = req.body && req.body.endpoint;
    if (typeof endpoint !== 'string' || !endpoint) return res.status(400).json({ error: 'Endpoint is required.' });
    await push.removeSubscription(req.user.id, endpoint);
    res.json({ message: 'Unsubscribed.' });
  } catch (err) {
    console.error('Push unsubscribe error:', err);
    res.status(500).json({ error: 'Could not turn off notifications.' });
  }
});

module.exports = router;