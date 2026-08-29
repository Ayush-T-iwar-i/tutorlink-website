const multer = require('multer');
const path = require('path');
const fs = require('fs');

// All uploaded documents land in backend/uploads — created automatically
// if it doesn't exist yet. Uploaded files are excluded in .gitignore.
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// Sanitize extensions: ensure only alphanumeric lowercase extensions
function sanitizeExt(originalname) {
  const ext = path.extname(originalname || '').toLowerCase();
  const allowedExts = ['.jpg', '.jpeg', '.png', '.webp', '.pdf'];
  return allowedExts.includes(ext) ? ext : '.bin';
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = sanitizeExt(file.originalname);
    const safeName = `${req.params.userId}_${file.fieldname}_${Date.now()}${ext}`;
    cb(null, safeName);
  },
});

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

function fileFilter(req, file, cb) {
  if (!ALLOWED_TYPES.includes(file.mimetype)) {
    const err = new Error('Only JPG, PNG, WEBP, or PDF files are allowed.');
    err.code = 'INVALID_FILE_TYPE';
    return cb(err);
  }
  cb(null, true);
}

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB per file
});

// ---------- Profile photos ----------
const PHOTO_DIR = path.join(__dirname, '..', 'uploads', 'photos');
if (!fs.existsSync(PHOTO_DIR)) {
  fs.mkdirSync(PHOTO_DIR, { recursive: true });
}

const photoStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, PHOTO_DIR),
  filename: (req, file, cb) => {
    const ext = sanitizeExt(file.originalname);
    cb(null, `${req.params.userId}_photo_${Date.now()}${ext}`);
  },
});

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

const uploadPhoto = multer({
  storage: photoStorage,
  fileFilter: (req, file, cb) => {
    if (!IMAGE_TYPES.includes(file.mimetype)) {
      const err = new Error('Only JPG, PNG, or WEBP images are allowed.');
      err.code = 'INVALID_FILE_TYPE';
      return cb(err);
    }
    cb(null, true);
  },
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB — profile photos should be small
});

module.exports = upload;
module.exports.photo = uploadPhoto;