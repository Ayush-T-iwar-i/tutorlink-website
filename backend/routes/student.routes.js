const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { verifyToken, requireRole, requireOwnUser } = require('../middleware/auth.middleware');

// ---------- UPDATE STUDENT LOCATION (protected: own account only) ----------
// PUT /api/students/:userId/location
// header: Authorization: Bearer <token>
// body: { address, latitude, longitude }
router.put('/:userId/location', verifyToken, requireOwnUser, requireRole('student'), async (req, res) => {
  try {
    const { userId } = req.params;
    const { address, latitude, longitude } = req.body;

    await db.query(
      'UPDATE students SET address = ?, latitude = ?, longitude = ? WHERE user_id = ?',
      [address, latitude, longitude, userId]
    );

    res.json({ message: 'Location updated successfully.' });
  } catch (err) {
    console.error('Update student location error:', err);
    res.status(500).json({ error: 'Could not update location.' });
  }
});

// ---------- UPDATE STUDENT PREFERENCES (protected: own account only) ----------
// PUT /api/students/:userId/preferences
// header: Authorization: Bearer <token>
// body: { preferred_subjects, preferred_grade }
router.put('/:userId/preferences', verifyToken, requireOwnUser, requireRole('student'), async (req, res) => {
  try {
    const { userId } = req.params;
    const { preferred_subjects, preferred_grade } = req.body;

    await db.query(
      'UPDATE students SET preferred_subjects = ?, preferred_grade = ? WHERE user_id = ?',
      [preferred_subjects, preferred_grade, userId]
    );

    res.json({ message: 'Preferences updated successfully.' });
  } catch (err) {
    console.error('Update preferences error:', err);
    res.status(500).json({ error: 'Could not update preferences.' });
  }
});

// ---------- GET STUDENT RECORD BY USER ID (protected: own account only) ----------
// GET /api/students/by-user/:userId
router.get('/by-user/:userId', verifyToken, requireOwnUser, async (req, res) => {
  try {
    const { userId } = req.params;
    const [rows] = await db.query('SELECT * FROM students WHERE user_id = ?', [userId]);

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Student profile not found.' });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error('Get student by user error:', err);
    res.status(500).json({ error: 'Could not fetch student record.' });
  }
});

module.exports = router;
