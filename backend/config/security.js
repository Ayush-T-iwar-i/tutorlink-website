'use strict';
// Security-related configuration that is read from environment variables, kept in one place so it can be
// unit-tested without starting the server.

// ---------- CORS ----------
// ALLOWED_ORIGIN accepts one origin or several separated by commas: https://a.com,https://www.a.com
function parseOrigins(value) {
  return String(value || '')
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

// Returns an error message when the production CORS setup is unsafe, otherwise null.
function corsProblem(env) {
  if (env.NODE_ENV !== 'production') return null;
  const origins = parseOrigins(env.ALLOWED_ORIGIN);
  if (origins.length === 0 || origins.includes('*')) {
    return 'ALLOWED_ORIGIN must be set to your real frontend domain(s) in production ("*" is not allowed).';
  }
  return null;
}

function buildCorsOptions(env) {
  const origins = parseOrigins(env.ALLOWED_ORIGIN).filter((o) => o !== '*');
  if (origins.length === 0) {
    // Development convenience only (production refuses to start without origins): allow the caller.
    return { origin: true, credentials: true };
  }
  return {
    origin(origin, callback) {
      // No Origin header = same-origin request, curl, server-to-server (e.g. the Razorpay webhook).
      if (!origin || origins.includes(origin)) return callback(null, true);
      return callback(null, false); // not allowed: no CORS headers are sent, the browser blocks it
    },
    credentials: true,
  };
}

// ---------- trust proxy ----------
// Number of reverse proxies in front of the app. It decides which IP address rate limits and login
// lockouts see. `true` would trust a client-supplied X-Forwarded-For and let anyone fake their IP.
function parseTrustProxy(value) {
  if (value === undefined || value === null || String(value).trim() === '') return 1; // previous default
  const text = String(value).trim().toLowerCase();
  if (text === 'true' || text === 'false') {
    throw new Error('TRUST_PROXY must be the NUMBER of proxies in front of the app (for example 1), not true/false.');
  }
  if (!/^\d+$/.test(text) || Number(text) > 10) {
    throw new Error('TRUST_PROXY must be a whole number between 0 and 10.');
  }
  return Number(text);
}

// ---------- Content-Security-Policy ----------
// CSP_MODE: report-only (default) | enforce | off
// The frontend still has inline scripts, inline event handlers and inline styles, so 'unsafe-inline' is
// required for now. This policy therefore does not stop injected inline scripts yet; it limits which
// outside origins can load scripts, frames and connections, and forbids <object>, <base> hijacking,
// foreign form posts and framing of the site. Report-only means nothing is blocked while you verify it.
function parseCspMode(value) {
  const mode = String(value || 'report-only').trim().toLowerCase();
  if (!['report-only', 'enforce', 'off'].includes(mode)) {
    throw new Error('CSP_MODE must be report-only, enforce or off.');
  }
  return mode;
}

const CSP_DIRECTIVES = {
  defaultSrc: ["'self'"],
  scriptSrc: [
    "'self'", "'unsafe-inline'",
    'https://unpkg.com', 'https://cdn.jsdelivr.net',
    'https://checkout.razorpay.com', 'https://accounts.google.com',
  ],
  styleSrc: [
    "'self'", "'unsafe-inline'",
    'https://unpkg.com', 'https://fonts.googleapis.com', 'https://accounts.google.com',
  ],
  fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
  imgSrc: [
    "'self'", 'data:', 'blob:',
    'https://unpkg.com', 'https://*.tile.openstreetmap.org',
    'https://*.googleusercontent.com', 'https://*.razorpay.com',
  ],
  connectSrc: [
    "'self'", 'https://nominatim.openstreetmap.org',
    'https://accounts.google.com', 'https://api.razorpay.com', 'https://lumberjack.razorpay.com',
  ],
  frameSrc: ['https://accounts.google.com', 'https://api.razorpay.com', 'https://checkout.razorpay.com'],
  objectSrc: ["'none'"],
  baseUri: ["'self'"],
  formAction: ["'self'"],
  frameAncestors: ["'self'"],
};

// Returns the value for helmet's `contentSecurityPolicy` option.
function buildCsp(mode) {
  if (mode === 'off') return false;
  return {
    useDefaults: false, // do not add upgrade-insecure-requests: it would break plain-http localhost
    reportOnly: mode !== 'enforce',
    directives: CSP_DIRECTIVES,
  };
}

// ---------- Permissions-Policy ----------
const PERMISSIONS_POLICY = 'geolocation=(self), camera=(), microphone=(), usb=(), magnetometer=(), gyroscope=()';

function permissionsPolicy(req, res, next) {
  res.setHeader('Permissions-Policy', PERMISSIONS_POLICY);
  next();
}

module.exports = {
  parseOrigins, corsProblem, buildCorsOptions,
  parseTrustProxy,
  parseCspMode, buildCsp, CSP_DIRECTIVES,
  PERMISSIONS_POLICY, permissionsPolicy,
};