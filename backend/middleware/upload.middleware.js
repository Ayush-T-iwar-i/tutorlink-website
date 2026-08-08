const multer = require('multer');
const path = require('path');
const fs = require('fs');

// All uploaded documents land in backend/uploads — created automatically
// if it doesn't exist yet. Add this folder to .gitignore; uploaded files
// should never be committed to the repo.
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    // userId + field name + timestamp, so re-uploads don't collide and
    // filenames can't be used to guess/overwrite someone else's file.
    const ext = path.extname(file.originalname);
    const safeName = `${req.params.userId}_${file.fieldname}_${Date.now()}${ext}`;
    cb(null, safeName);
  },
});

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

function fileFilter(req, file, cb) {
  if (!ALLOWED_TYPES.includes(file.mimetype)) {
    return cb(new Error('Only JPG, PNG, WEBP, or PDF files are allowed.'));
  }
  cb(null, true);
}

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB per file
});

// ---------- Profile photos ----------
// Separate from the ID/verification documents above: these are meant to
// be publicly visible on a teacher's profile, so they live in their own
// folder that's served as public static files (see server.js), while the
// documents folder above never is.
const PHOTO_DIR = path.join(__dirname, '..', 'uploads', 'photos');
if (!fs.existsSync(PHOTO_DIR)) {
  fs.mkdirSync(PHOTO_DIR, { recursive: true });
}

const photoStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, PHOTO_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${req.params.userId}_photo_${Date.now()}${ext}`);
  },
});

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

const uploadPhoto = multer({
  storage: photoStorage,
  fileFilter: (req, file, cb) => {
    if (!IMAGE_TYPES.includes(file.mimetype)) {
      return cb(new Error('Only JPG, PNG, or WEBP images are allowed.'));
    }
    cb(null, true);
  },
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB — profile photos should be small
});

module.exports = upload;
module.exports.photo = uploadPhoto;