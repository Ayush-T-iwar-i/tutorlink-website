const express = require('express');
const router = express.Router();

// ---------- PUBLIC CONFIG (safe values only — never put secrets here) ----------
// GET /api/config
// Frontend calls this on page load to know whether Google Sign-In is set up.
router.get('/', (req, res) => {
  res.json({
    googleClientId: process.env.GOOGLE_CLIENT_ID || '',
    defaultRadiusKm: process.env.DEFAULT_RADIUS_KM || 5,
  });
});

module.exports = router;
