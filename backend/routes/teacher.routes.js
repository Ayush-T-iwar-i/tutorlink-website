const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { verifyToken, requireRole, requireOwnUser } = require('../middleware/auth.middleware');

// ---------- UPDATE TEACHER PROFILE (protected: must be logged-in teacher, own account) ----------
// PUT /api/teachers/:userId/profile
// header: Authorization: Bearer <token>
// body: { qualification, subjects, grades, experience_years, fee_per_hour, languages, bio, address, city }
router.put('/:userId/profile', verifyToken, requireOwnUser, requireRole('teacher'), async (req, res) => {
  try {
    const { userId } = req.params;
    const { qualification, subjects, grades, experience_years, fee_per_hour, languages, bio, address, city } = req.body;

    await db.query(
      `UPDATE teachers SET
        qualification = ?, subjects = ?, grades = ?, experience_years = ?,
        fee_per_hour = ?, languages = ?, bio = ?, address = ?, city = ?
       WHERE user_id = ?`,
      [qualification, subjects, grades, experience_years, fee_per_hour, languages, bio, address, city, userId]
    );

    res.json({ message: 'Profile updated successfully.' });
  } catch (err) {
    console.error('Update profile error:', err);
    res.status(500).json({ error: 'Could not update profile.' });
  }
});

// ---------- UPDATE TEACHER LOCATION + RADIUS (protected) ----------
// PUT /api/teachers/:userId/location
// header: Authorization: Bearer <token>
// body: { latitude, longitude, travel_radius_km }
router.put('/:userId/location', verifyToken, requireOwnUser, requireRole('teacher'), async (req, res) => {
  try {
    const { userId } = req.params;
    const { latitude, longitude, travel_radius_km } = req.body;

    await db.query(
      'UPDATE teachers SET latitude = ?, longitude = ?, travel_radius_km = ? WHERE user_id = ?',
      [latitude, longitude, travel_radius_km, userId]
    );

    res.json({ message: 'Location updated successfully.' });
  } catch (err) {
    console.error('Update location error:', err);
    res.status(500).json({ error: 'Could not update location.' });
  }
});

// ---------- SEARCH NEARBY TEACHERS (public — no login needed to browse) ----------
// GET /api/teachers/nearby?lat=...&lng=...&radius=5&subject=Maths
router.get('/nearby', async (req, res) => {
  try {
    const { lat, lng, radius, subject } = req.query;

    if (!lat || !lng) {
      return res.status(400).json({ error: 'lat and lng query params are required.' });
    }

    const searchRadius = radius || process.env.DEFAULT_RADIUS_KM || 5;

    let sql = `
      SELECT
        t.id, u.name, u.profile_photo, t.qualification, t.subjects, t.grades,
        t.experience_years, t.fee_per_hour, t.address, t.city,
        t.rating_avg, t.total_reviews,
        t.latitude, t.longitude,
        (6371 * ACOS(
          COS(RADIANS(?)) * COS(RADIANS(t.latitude)) *
          COS(RADIANS(t.longitude) - RADIANS(?)) +
          SIN(RADIANS(?)) * SIN(RADIANS(t.latitude))
        )) AS distance_km
      FROM teachers t
      JOIN users u ON u.id = t.user_id
      WHERE t.verification_status = 'approved'
        AND t.latitude IS NOT NULL
        AND t.longitude IS NOT NULL
    `;

    const params = [lat, lng, lat];

    if (subject) {
      sql += ' AND t.subjects LIKE ?';
      params.push(`%${subject}%`);
    }

    sql += ' HAVING distance_km <= ? ORDER BY distance_km ASC';
    params.push(searchRadius);

    const [rows] = await db.query(sql, params);

    res.json({ count: rows.length, radius_km: searchRadius, teachers: rows });
  } catch (err) {
    console.error('Nearby search error:', err);
    res.status(500).json({ error: 'Could not search nearby teachers.' });
  }
});

// ---------- GET TEACHER RECORD BY USER ID (protected: own account only) ----------
// GET /api/teachers/by-user/:userId
router.get('/by-user/:userId', verifyToken, requireOwnUser, async (req, res) => {
  try {
    const { userId } = req.params;
    const [rows] = await db.query('SELECT * FROM teachers WHERE user_id = ?', [userId]);

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Teacher profile not found.' });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error('Get teacher by user error:', err);
    res.status(500).json({ error: 'Could not fetch teacher record.' });
  }
});

// ---------- GET SINGLE TEACHER PROFILE (public — students need to view profiles) ----------
// GET /api/teachers/:id
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await db.query(
      `SELECT t.id, t.qualification, t.subjects, t.grades, t.experience_years,
              t.fee_per_hour, t.languages, t.bio, t.address, t.city,
              t.rating_avg, t.total_reviews, u.name, u.profile_photo
       FROM teachers t JOIN users u ON u.id = t.user_id
       WHERE t.id = ? AND t.verification_status = 'approved'`,
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Teacher not found.' });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error('Get teacher error:', err);
    res.status(500).json({ error: 'Could not fetch teacher profile.' });
  }
});

module.exports = router;
