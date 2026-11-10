const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { verifyToken, requireRole, requireOwnUser } = require('../middleware/auth.middleware');
const upload = require('../middleware/upload.middleware');
const { optionalText, optionalCoordinates, sendValidationError } = require('../lib/validate');

// ---------- UPDATE STUDENT LOCATION (protected: own account only) ----------
// PUT /api/students/:userId/location
// header: Authorization: Bearer <token>
// body: { address, latitude, longitude }
router.put('/:userId/location', verifyToken, requireOwnUser, requireRole('student'), async (req, res) => {
  try {
    const body = req.body || {};
    const { lat, lng } = optionalCoordinates(body.latitude, body.longitude);
    const pincode = optionalText(body.pincode == null ? body.pincode : String(body.pincode), 10, 'Pincode');
    const values = [
      optionalText(body.address, 255, 'Address'),
      optionalText(body.city, 100, 'City'),
      optionalText(body.area, 150, 'Area'),
      optionalText(body.district, 150, 'District'),
      pincode,
      lat,
      lng,
    ];

    await db.query(
      `UPDATE students
       SET address = ?, city = ?, area = ?, district = ?, pincode = ?, latitude = ?, longitude = ?
       WHERE user_id = ?`,
      [...values, req.params.userId]
    );

    res.json({ message: 'Location updated successfully.' });
  } catch (err) {
    if (sendValidationError(res, err)) return;
    console.error('Update student location error:', err);
    res.status(500).json({ error: 'Could not update location.' });
  }
});

router.put('/:userId/preferences', verifyToken, requireOwnUser, requireRole('student'), async (req, res) => {
  try {
    const { userId } = req.params;
    const body = req.body || {};
    const preferredSubjects = optionalText(body.preferred_subjects, 255, 'Preferred subjects');
    const preferredGrade = optionalText(body.preferred_grade, 50, 'Preferred grade');

    await db.query(
      'UPDATE students SET preferred_subjects = ?, preferred_grade = ? WHERE user_id = ?',
      [preferredSubjects, preferredGrade, userId]
    );

    res.json({ message: 'Preferences updated successfully.' });
  } catch (err) {
    if (sendValidationError(res, err)) return;
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

// ---------- UPLOAD PROFILE PHOTO ----------
// POST /api/students/:userId/photo   multipart/form-data field: "photo"
router.post('/:userId/photo', verifyToken, requireOwnUser, upload.photo.single('photo'), upload.verifyRealFileType('photo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No photo was uploaded.' });
    await db.query('UPDATE users SET profile_photo = ? WHERE id = ?', [`photos/${req.file.filename}`, req.params.userId]);
    res.json({ message: 'Profile photo updated.', path: `photos/${req.file.filename}` });
  } catch (err) {
    console.error('Upload student photo error:', err);
    res.status(500).json({ error: 'Could not upload photo.' });
  }
});

module.exports = router;
