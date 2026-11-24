const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { verifyToken } = require('../middleware/auth.middleware');
const { sendPushToUser } = require('../lib/push');

// ---------- GET MY NOTIFICATIONS (most recent first) ----------
// GET /api/notifications/me
router.get('/me', verifyToken, async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 30',
      [req.user.id]
    );
    const [[{ unread }]] = await db.query(
      'SELECT COUNT(*) AS unread FROM notifications WHERE user_id = ? AND is_read = 0',
      [req.user.id]
    );
    res.json({ notifications: rows, unread_count: unread });
  } catch (err) {
    console.error('Get notifications error:', err);
    res.status(500).json({ error: 'Could not fetch notifications.' });
  }
});

// ---------- MARK ONE NOTIFICATION AS READ ----------
// PUT /api/notifications/:id/read
router.put('/:id/read', verifyToken, async (req, res) => {
  try {
    await db.query(
      'UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );
    res.json({ message: 'Marked as read.' });
  } catch (err) {
    console.error('Mark notification read error:', err);
    res.status(500).json({ error: 'Could not update notification.' });
  }
});

// ---------- MARK ALL AS READ ----------
// PUT /api/notifications/read-all
router.put('/read-all', verifyToken, async (req, res) => {
  try {
    await db.query('UPDATE notifications SET is_read = 1 WHERE user_id = ?', [req.user.id]);
    res.json({ message: 'All notifications marked as read.' });
  } catch (err) {
    console.error('Mark all notifications read error:', err);
    res.status(500).json({ error: 'Could not update notifications.' });
  }
});

// ---------- DELETE ONE NOTIFICATION ----------
// DELETE /api/notifications/:id   (only your own)
router.delete('/:id', verifyToken, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid notification id.' });
    await db.query('DELETE FROM notifications WHERE id = ? AND user_id = ?', [id, req.user.id]);
    res.json({ message: 'Notification deleted.' });
  } catch (err) {
    console.error('Delete notification error:', err);
    res.status(500).json({ error: 'Could not delete notification.' });
  }
});

// ---------- CLEAR ALL MY NOTIFICATIONS ----------
// DELETE /api/notifications
router.delete('/', verifyToken, async (req, res) => {
  try {
    await db.query('DELETE FROM notifications WHERE user_id = ?', [req.user.id]);
    res.json({ message: 'All notifications cleared.' });
  } catch (err) {
    console.error('Clear notifications error:', err);
    res.status(500).json({ error: 'Could not clear notifications.' });
  }
});

module.exports = router;

/**
 * Helper used by other route files to create a notification.
 * Not mounted as a route — imported directly:
 *   const { createNotification } = require('../routes/notification.routes');
 */
module.exports.createNotification = async function createNotification(userId, message, link, pushOptions) {
  try {
    await db.query(
      'INSERT INTO notifications (user_id, message, link) VALUES (?, ?, ?)',
      [userId, message, link || null]
    );
  } catch (err) {
    console.error('Create notification error:', err);
    return;
  }
  // Also show it on the person's phone/laptop. Not awaited: it must never slow the request down.
  // pushOptions (optional) can set { title, body, url, tag }.
  const opts = pushOptions || {};
  sendPushToUser(userId, {
    title: opts.title || 'GharTutor',
    body: opts.body || message,
    url: opts.url || link || 'index.html',
    tag: opts.tag,
  });
};