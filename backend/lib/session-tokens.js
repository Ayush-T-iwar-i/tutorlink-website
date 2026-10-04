/**
 * Pure helpers for access tokens, refresh tokens and auth cookies (no database).
 *
 * Model
 *  - Access token: a short-lived JWT (default 15 min) carrying { id, role, sid }. `sid` is the id of a
 *    row in the `sessions` table; the middleware checks that row on every request, so logging out,
 *    changing a password or deleting a user takes effect immediately.
 *  - Refresh token: an opaque 256-bit random value (NOT a JWT). Only its SHA-256 hash is stored.
 *    It is rotated on every use. Both cookies are httpOnly, so page JavaScript can never read them.
 */
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const intFromEnv = (name, fallback) => {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const accessTtlMinutes = () => intFromEnv('ACCESS_TOKEN_TTL_MIN', 15);
const refreshTtlDays = () => intFromEnv('REFRESH_TOKEN_TTL_DAYS', 14);
const REFRESH_ABSOLUTE_DAYS = 90;   // a login can never be extended past this, however often it is refreshed
const REFRESH_GRACE_SECONDS = 10;   // concurrent tabs may present the just-rotated token for this long

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not set.');
  return secret;
}

function signAccessToken({ id, role, sid }) {
  return jwt.sign({ id, role, sid }, getJwtSecret(), { algorithm: 'HS256', expiresIn: `${accessTtlMinutes()}m` });
}

/** Throws jwt.JsonWebTokenError / TokenExpiredError. Only HS256 is accepted (blocks alg:none / alg confusion). */
function verifyAccessToken(token, { ignoreExpiration = false } = {}) {
  return jwt.verify(token, getJwtSecret(), { algorithms: ['HS256'], ignoreExpiration });
}

const generateRefreshToken = () => crypto.randomBytes(32).toString('base64url');
const hashToken = (raw) => crypto.createHash('sha256').update(String(raw)).digest('hex');

/** One-time email tokens (password reset / email verification): hex random, stored only as a hash. */
function generateEmailToken() {
  const raw = crypto.randomBytes(32).toString('hex');
  return { raw, hash: hashToken(raw) };
}

const ACCESS_COOKIE = 'token';
const REFRESH_COOKIE = 'refresh_token';
const REFRESH_COOKIE_PATH = '/api/auth';

function baseCookie() {
  return { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' };
}

/**
 * Sets the access cookie, and the refresh cookie when a refresh token is supplied.
 * The access cookie outlives the JWT inside it on purpose: an expired token then reaches the server
 * and gets a precise TOKEN_EXPIRED answer, which tells the frontend to refresh.
 */
function setAuthCookies(res, { accessToken, refreshToken }) {
  res.cookie(ACCESS_COOKIE, accessToken, { ...baseCookie(), path: '/', maxAge: refreshTtlDays() * 86400000 });
  if (refreshToken) {
    res.cookie(REFRESH_COOKIE, refreshToken, { ...baseCookie(), path: REFRESH_COOKIE_PATH, maxAge: refreshTtlDays() * 86400000 });
  }
}

function clearAuthCookies(res) {
  res.clearCookie(ACCESS_COOKIE, { ...baseCookie(), path: '/' });
  res.clearCookie(REFRESH_COOKIE, { ...baseCookie(), path: REFRESH_COOKIE_PATH });
}

module.exports = {
  accessTtlMinutes, refreshTtlDays, REFRESH_ABSOLUTE_DAYS, REFRESH_GRACE_SECONDS,
  getJwtSecret, signAccessToken, verifyAccessToken,
  generateRefreshToken, hashToken, generateEmailToken,
  ACCESS_COOKIE, REFRESH_COOKIE, REFRESH_COOKIE_PATH,
  setAuthCookies, clearAuthCookies,
};