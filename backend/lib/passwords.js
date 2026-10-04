/**
 * Password hashing and the one password policy shared by signup, reset and change-password.
 */
const bcrypt = require('bcryptjs');

const MAX_BYTES = 72; // bcrypt silently ignores everything after 72 bytes, so longer passwords are refused

// Cost 12 in production. Tests lower it (BCRYPT_ROUNDS=4) so the suite stays fast.
function rounds() {
  const n = parseInt(process.env.BCRYPT_ROUNDS, 10);
  return Number.isInteger(n) && n >= 4 && n <= 15 ? n : 12;
}

const COMMON = new Set([
  'password1', 'password12', 'password123', 'password1234', 'password!1', 'passw0rd', 'passw0rd1',
  'qwerty123', 'qwerty1234', 'qwertyuiop1', 'welcome1', 'welcome123', 'letmein123', 'admin123',
  'admin1234', 'iloveyou1', 'abc12345', 'abcd1234', 'abcd12345', 'test1234', 'test12345',
  'tutorlink1', 'tutorlink123', '12345678a', 'a1234567', 'india1234', 'india@123', 'monkey123',
  'dragon123', 'football1', 'princess1', 'sunshine1', 'changeme1', 'changeme123',
]);

/** Returns an error message, or null when the password is acceptable. */
function validatePassword(pw, label = 'Password') {
  if (typeof pw !== 'string') return `${label} is required.`;
  if (pw.length < 8) return `${label} must be at least 8 characters.`;
  if (Buffer.byteLength(pw, 'utf8') > MAX_BYTES) return `${label} must be at most ${MAX_BYTES} characters.`;
  if (!/[A-Z]/.test(pw)) return `${label} must include at least one uppercase letter.`;
  if (!/[a-z]/.test(pw)) return `${label} must include at least one lowercase letter.`;
  if (!/[0-9]/.test(pw)) return `${label} must include at least one number.`;
  if (COMMON.has(pw.toLowerCase())) return `${label} is too common. Please choose something harder to guess.`;
  return null;
}

/** express-validator custom() adapter. */
const passwordRule = (label) => (value) => {
  const err = validatePassword(value, label);
  if (err) throw new Error(err);
  return true;
};

const hashPassword = (plain) => bcrypt.hash(plain, rounds());

// A real hash to compare against when the account does not exist, so "no such user" and
// "wrong password" take the same time and cannot be told apart by timing.
let dummyHash;
async function verifyPassword(plain, hash) {
  if (!dummyHash) dummyHash = bcrypt.hashSync('timing-equaliser-not-a-real-password', rounds());
  const ok = await bcrypt.compare(typeof plain === 'string' ? plain : '', hash || dummyHash);
  return Boolean(hash) && ok;
}

module.exports = { validatePassword, passwordRule, hashPassword, verifyPassword, MAX_BYTES };