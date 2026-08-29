const express = require('express');
const router = express.Router();
const path = require('path');
const db = require('../config/db');
const { verifyToken, requireRole, requireOwnUser } = require('../middleware/auth.middleware');
const upload = require('../middleware/upload.middleware');

// ---------- UPLOAD VERIFICATION DOCUMENTS (protected: own account, teacher only) ----------
// POST /api/teachers/:userId/documents
// multipart/form-data fields: id_proof, address_proof, certificate (each optional, one file)
// Submitting any document resets verification_status to "pending" so an admin re-reviews.
router.post(
  '/:userId/documents',
  verifyToken, requireOwnUser, requireRole('teacher'),
  upload.fields([
    { name: 'id_proof', maxCount: 1 },
    { name: 'address_proof', maxCount: 1 },
    { name: 'certificate', maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const { userId } = req.params;
      const files = req.files || {};

      const updates = [];
      const params = [];

      if (files.id_proof) { updates.push('id_proof_path = ?'); params.push(files.id_proof[0].filename); }
      if (files.address_proof) { updates.push('address_proof_path = ?'); params.push(files.address_proof[0].filename); }
      if (files.certificate) { updates.push('certificate_path = ?'); params.push(files.certificate[0].filename); }

      if (updates.length === 0) {
        return res.status(400).json({ error: 'No files were uploaded.' });
      }

      updates.push('verification_status = ?');
      params.push('pending');
      params.push(userId);

      await db.query(`UPDATE teachers SET ${updates.join(', ')} WHERE user_id = ?`, params);

      res.json({ message: 'Documents uploaded. Your profile will be reviewed shortly.' });
    } catch (err) {
      console.error('Upload documents error:', err);
      res.status(500).json({ error: err.message || 'Could not upload documents.' });
    }
  }
);

// ---------- UPDATE TEACHER PROFILE (protected: must be logged-in teacher, own account) ----------
// PUT /api/teachers/:userId/profile
// body: { qualification, subjects, grades, experience_years, fee_per_hour, languages, bio, address, city, available_slots }
router.put('/:userId/profile', verifyToken, requireOwnUser, requireRole('teacher'), async (req, res) => {
  try {
    const { userId } = req.params;
    const {
      qualification, subjects, grades, experience_years,
      fee_per_hour, languages, bio, address, city, available_slots,
    } = req.body;

    const exp = Math.max(0, parseInt(experience_years, 10) || 0);
    const fee = Math.max(0, parseFloat(fee_per_hour) || 0);

    await db.query(
      `UPDATE teachers SET
        qualification = ?, subjects = ?, grades = ?, experience_years = ?,
        fee_per_hour = ?, languages = ?, bio = ?, address = ?, city = ?, available_slots = ?
       WHERE user_id = ?`,
      [
        qualification || null,
        subjects || '',
        grades || null,
        exp,
        fee,
        languages || null,
        bio || null,
        address || null,
        city || null,
        available_slots || null,
        userId,
      ]
    );

    res.json({ message: 'Profile updated successfully.' });
  } catch (err) {
    console.error('Update profile error:', err);
    res.status(500).json({ error: 'Could not update profile.' });
  }
});

// ---------- UPDATE TEACHER LOCATION + RADIUS (protected) ----------
// PUT /api/teachers/:userId/location
// body: { latitude, longitude, travel_radius_km }
router.put('/:userId/location', verifyToken, requireOwnUser, requireRole('teacher'), async (req, res) => {
  try {
    const { userId } = req.params;
    const { latitude, longitude, travel_radius_km } = req.body;

    const lat = parseFloat(latitude);
    const lng = parseFloat(longitude);
    const radius = Math.min(50, Math.max(1, parseFloat(travel_radius_km) || 5));

    if (isNaN(lat) || lat < -90 || lat > 90 || isNaN(lng) || lng < -180 || lng > 180) {
      return res.status(400).json({ error: 'Invalid latitude or longitude values.' });
    }

    await db.query(
      'UPDATE teachers SET latitude = ?, longitude = ?, travel_radius_km = ? WHERE user_id = ?',
      [lat, lng, radius, userId]
    );

    res.json({ message: 'Location updated successfully.' });
  } catch (err) {
    console.error('Update location error:', err);
    res.status(500).json({ error: 'Could not update location.' });
  }
});

// ---------- PUBLIC TEACHER DIRECTORY (no login, no location required) ----------
// GET /api/teachers/browse?subject=&city=&sort=rating|fee_low|fee_high|experience&page=1&limit=12
router.get('/browse', async (req, res) => {
  try {
    const { subject, city, sort = 'rating', page = 1, limit = 12 } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(50, Math.max(1, parseInt(limit, 10) || 12));
    const offset = (pageNum - 1) * limitNum;

    const conditions = [`t.verification_status = 'approved'`];
    const params = [];
    if (subject) { conditions.push('t.subjects LIKE ?'); params.push(`%${subject.trim()}%`); }
    if (city) { conditions.push('t.city LIKE ?'); params.push(`%${city.trim()}%`); }
    const whereClause = conditions.join(' AND ');

    const sortMap = {
      rating: 't.rating_avg DESC, t.total_reviews DESC',
      fee_low: 't.fee_per_hour ASC',
      fee_high: 't.fee_per_hour DESC',
      experience: 't.experience_years DESC',
    };
    const orderBy = sortMap[sort] || sortMap.rating;

    const [rows] = await db.query(
      `SELECT t.id, u.name, u.profile_photo, t.subjects, t.grades, t.qualification, t.experience_years,
              t.fee_per_hour, t.rating_avg, t.total_reviews, t.city
       FROM teachers t JOIN users u ON u.id = t.user_id
       WHERE ${whereClause}
       ORDER BY ${orderBy}
       LIMIT ? OFFSET ?`,
      [...params, limitNum, offset]
    );

    const [[{ total }]] = await db.query(
      `SELECT COUNT(*) AS total FROM teachers t WHERE ${whereClause}`,
      params
    );

    res.json({
      teachers: rows,
      page: pageNum,
      limit: limitNum,
      total,
      total_pages: Math.ceil(total / limitNum) || 1,
    });
  } catch (err) {
    console.error('Browse teachers error:', err);
    res.status(500).json({ error: 'Could not fetch teachers.' });
  }
});

// ---------- SEARCH NEARBY TEACHERS (public — distance matched) ----------
// GET /api/teachers/nearby?lat=...&lng=...&radius=5&subject=Maths
router.get('/nearby', async (req, res) => {
  try {
    const { lat, lng, radius, subject, page = 1, limit = 20 } = req.query;

    const latitude = parseFloat(lat);
    const longitude = parseFloat(lng);

    if (isNaN(latitude) || latitude < -90 || latitude > 90 || isNaN(longitude) || longitude < -180 || longitude > 180) {
      return res.status(400).json({ error: 'Valid lat and lng query params are required.' });
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(50, Math.max(1, parseInt(limit, 10) || 20));
    const offset = (pageNum - 1) * limitNum;
    const searchRadius = Math.min(100, Math.max(0.5, parseFloat(radius) || parseFloat(process.env.DEFAULT_RADIUS_KM) || 5));

    // Clamped Haversine formula prevents NaN/NULL in MySQL when lat/lng are identical
    let sql = `
      SELECT
        t.id, u.name, u.profile_photo, t.qualification, t.subjects, t.grades,
        t.experience_years, t.fee_per_hour, t.address, t.city,
        t.rating_avg, t.total_reviews,
        t.latitude, t.longitude,
        (6371 * ACOS(
          LEAST(1.0, GREATEST(-1.0,
            COS(RADIANS(?)) * COS(RADIANS(t.latitude)) *
            COS(RADIANS(t.longitude) - RADIANS(?)) +
            SIN(RADIANS(?)) * SIN(RADIANS(t.latitude))
          ))
        )) AS distance_km
      FROM teachers t
      JOIN users u ON u.id = t.user_id
      WHERE t.verification_status = 'approved'
        AND t.latitude IS NOT NULL
        AND t.longitude IS NOT NULL
    `;

    const params = [latitude, longitude, latitude];

    if (subject) {
      sql += ' AND t.subjects LIKE ?';
      params.push(`%${subject.trim()}%`);
    }

    const countSql = `SELECT COUNT(*) AS total FROM (${sql} HAVING distance_km <= ?) AS matched`;
    const [[{ total }]] = await db.query(countSql, [...params, searchRadius]);

    sql += ' HAVING distance_km <= ? ORDER BY distance_km ASC LIMIT ? OFFSET ?';
    params.push(searchRadius, limitNum, offset);

    const [rows] = await db.query(sql, params);

    res.json({
      count: rows.length,
      total,
      page: pageNum,
      total_pages: Math.ceil(total / limitNum) || 1,
      radius_km: searchRadius,
      teachers: rows,
    });
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

// ---------- GET SINGLE TEACHER PROFILE (public) ----------
// GET /api/teachers/:id
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await db.query(
      `SELECT t.id, t.qualification, t.subjects, t.grades, t.experience_years,
              t.fee_per_hour, t.languages, t.bio, t.address, t.city, t.available_slots,
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

// ---------- VIEW AN UPLOADED DOCUMENT (protected: the teacher themself, or an admin) ----------
// GET /api/teachers/:userId/documents/:type   where type = id_proof | address_proof | certificate
router.get('/:userId/documents/:type', verifyToken, async (req, res) => {
  try {
    const { userId, type } = req.params;
    const columnMap = {
      id_proof: 'id_proof_path',
      address_proof: 'address_proof_path',
      certificate: 'certificate_path',
    };
    const column = columnMap[type];
    if (!column) {
      return res.status(400).json({ error: 'Unknown document type.' });
    }

    const isOwner = req.user.id === parseInt(userId, 10);
    const isAdmin = req.user.role === 'admin';
    if (!isOwner && !isAdmin) {
      return res.status(403).json({ error: 'You are not allowed to view this document.' });
    }

    const [rows] = await db.query(`SELECT ${column} AS filename FROM teachers WHERE user_id = ?`, [userId]);
    if (rows.length === 0 || !rows[0].filename) {
      return res.status(404).json({ error: 'No document of this type has been uploaded.' });
    }

    res.sendFile(rows[0].filename, { root: path.join(__dirname, '..', 'uploads') });
  } catch (err) {
    console.error('View document error:', err);
    res.status(500).json({ error: 'Could not load document.' });
  }
});

// ---------- UPLOAD PROFILE PHOTO ----------
// POST /api/teachers/:userId/photo   multipart/form-data field: "photo"
router.post('/:userId/photo', verifyToken, requireOwnUser, upload.photo.single('photo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No photo was uploaded.' });
    await db.query('UPDATE users SET profile_photo = ? WHERE id = ?', [`photos/${req.file.filename}`, req.params.userId]);
    res.json({ message: 'Profile photo updated.', path: `photos/${req.file.filename}` });
  } catch (err) {
    console.error('Upload teacher photo error:', err);
    res.status(500).json({ error: err.message || 'Could not upload photo.' });
  }
});

module.exports = router;