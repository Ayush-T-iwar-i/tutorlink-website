
const fs = require('fs');
const path = require('path');
const db = require('../config/db');

const ROOT = path.join(__dirname, '..', 'uploads');
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.pdf': 'application/pdf' };

// A stored path looks like "photos/8_photo_123.jpg" or "8_id_proof_123.pdf". Anything else is refused.
function safeRel(rel) {
  if (typeof rel !== 'string' || !rel || rel.length > 255) return null;
  if (!/^(photos\/)?[A-Za-z0-9_.-]+$/.test(rel) || rel.includes('..')) return null;
  return rel;
}

/** Copy a file that is already on disk into the database. Never throws; returns true on success. */
async function persist(rel, absPath) {
  try {
    const safe = safeRel(rel);
    const mime = MIME[path.extname(rel || '').toLowerCase()];
    if (!safe || !mime) return false;
    const data = await fs.promises.readFile(absPath);
    await db.query(
      `INSERT INTO uploaded_files (path, mime, data) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE mime = VALUES(mime), data = VALUES(data)`,
      [safe, mime, data]
    );
    return true;
  } catch (err) {
    console.error('Could not save uploaded file to the database:', err && err.message);
    return false;
  }
}

/** Make sure the file exists on disk, restoring it from the database if needed. Never throws. */
async function restore(rel) {
  try {
    const safe = safeRel(rel);
    if (!safe) return false;
    const target = path.join(ROOT, safe);
    if (fs.existsSync(target)) return true;
    const [rows] = await db.query('SELECT data FROM uploaded_files WHERE path = ?', [safe]);
    if (!rows.length) return false;
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, rows[0].data);
    return true;
  } catch (err) {
    console.error('Could not restore uploaded file:', err && err.message);
    return false;
  }
}

module.exports = { persist, restore, safeRel, ROOT };