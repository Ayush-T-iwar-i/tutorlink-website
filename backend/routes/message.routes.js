const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { createNotification } = require('./notification.routes');
const { verifyToken } = require('../middleware/auth.middleware');

// Confirms the logged-in user is either the student or the teacher on this
// booking, and returns both user_ids so routes below can reuse them.
async function getBookingParticipants(bookingId) {
  const [rows] = await db.query(
    `SELECT s.user_id AS student_user_id, t.user_id AS teacher_user_id, b.status
     FROM bookings b
     JOIN students s ON s.id = b.student_id
     JOIN teachers t ON t.id = b.teacher_id
     WHERE b.id = ?`,
    [bookingId]
  );
  return rows[0] || null;
}

// ---------- GET CHAT HISTORY FOR A BOOKING ----------
// GET /api/messages/:bookingId
router.get('/:bookingId', verifyToken, async (req, res) => {
  try {
    const participants = await getBookingParticipants(req.params.bookingId);
    if (!participants) return res.status(404).json({ error: 'Booking not found.' });

    const isParticipant = req.user.id === participants.student_user_id || req.user.id === participants.teacher_user_id;
    if (!isParticipant) return res.status(403).json({ error: 'You are not part of this conversation.' });

    const [messages] = await db.query(
      `SELECT m.*, u.name AS sender_name
       FROM messages m JOIN users u ON u.id = m.sender_id
       WHERE m.booking_id = ? ORDER BY m.created_at ASC`,
      [req.params.bookingId]
    );

    // Mark the other person's messages as read now that this user opened the chat
    await db.query(
      'UPDATE messages SET is_read = 1 WHERE booking_id = ? AND sender_id != ?',
      [req.params.bookingId, req.user.id]
    );

    res.json(messages);
  } catch (err) {
    console.error('Get messages error:', err);
    res.status(500).json({ error: 'Could not load chat.' });
  }
});

// ---------- SEND A MESSAGE ----------
// POST /api/messages/:bookingId
// body: { message }
router.post('/:bookingId', verifyToken, async (req, res) => {
  try {
    const { message } = req.body || {};
    if (typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'Message cannot be empty.' });
    }
    if (message.length > 1000) {
      return res.status(400).json({ error: 'Message is too long (max 1000 characters).' });
    }

    const participants = await getBookingParticipants(req.params.bookingId);
    if (!participants) return res.status(404).json({ error: 'Booking not found.' });

    const isParticipant = req.user.id === participants.student_user_id || req.user.id === participants.teacher_user_id;
    if (!isParticipant) return res.status(403).json({ error: 'You are not part of this conversation.' });

    if (participants.status === 'requested') {
      return res.status(400).json({ error: 'Chat opens once the teacher accepts this booking.' });
    }
    if (participants.status === 'declined' || participants.status === 'cancelled') {
      return res.status(400).json({ error: 'This booking is closed, so new messages cannot be sent.' });
    }

    const [result] = await db.query(
      'INSERT INTO messages (booking_id, sender_id, message) VALUES (?, ?, ?)',
      [req.params.bookingId, req.user.id, message.trim()]
    );

    const otherUserId = req.user.id === participants.student_user_id
      ? participants.teacher_user_id
      : participants.student_user_id;
    const link = req.user.id === participants.student_user_id ? 'teacher-dashboard.html' : 'student-dashboard.html';
    await createNotification(otherUserId, 'You have a new message.', link);

    res.status(201).json({ id: result.insertId, message: message.trim(), created_at: new Date() });
  } catch (err) {
    console.error('Send message error:', err);
    res.status(500).json({ error: 'Could not send message.' });
  }
});

module.exports = router;