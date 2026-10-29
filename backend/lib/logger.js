'use strict';
// Structured logger with request correlation and secret redaction. No external dependency.
//
//   logger.info('Booking created', { bookingId: 12 });
//   logger.error('Refund failed', { err });          // Error objects are reduced to name/code/message
//
// Output:  production -> one JSON object per line (easy for log collectors)
//          otherwise  -> readable text
// LOG_LEVEL = debug | info | warn | error   (default: info; silent under Jest unless LOG_LEVEL is set)
//
// Never logged: values of keys that look like secrets (password, token, secret, signature, cookie,
// authorization, api key), SQL text of database errors, and the values inside "Duplicate entry" messages.

const { AsyncLocalStorage } = require('async_hooks');
const util = require('util');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const store = new AsyncLocalStorage();

const SENSITIVE_KEY = /(pass(word|wd)?|token|secret|signature|cookie|authorization|api[_-]?key)/i;
const EXACT_SENSITIVE_KEY = /^(otp|cvv|sql|sqlmessage)$/i;
const MAX_DEPTH = 4;
const MAX_STRING = 2000;

let writer = defaultWriter;

function defaultWriter(level, line) {
  const stream = LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout;
  stream.write(line + '\n');
}

function threshold() {
  const configured = String(process.env.LOG_LEVEL || '').toLowerCase();
  if (LEVELS[configured]) return LEVELS[configured];
  if (process.env.NODE_ENV === 'test') return Infinity; // keep test output clean
  return LEVELS.info;
}

// ---------- redaction ----------
function sanitizeMessage(text) {
  let s = String(text);
  s = s.replace(/Duplicate entry '[^']*' for key/gi, 'Duplicate entry [REDACTED] for key');
  s = s.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [REDACTED]');
  s = s.replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g, '[REDACTED_JWT]');
  if (s.length > MAX_STRING) s = s.slice(0, MAX_STRING) + '…[truncated]';
  return s;
}

function serializeError(err) {
  if (!err || typeof err !== 'object') return { message: sanitizeMessage(err) };
  const out = { name: err.name, message: sanitizeMessage(err.message || '') };
  if (err.code !== undefined) out.code = err.code;
  const status = err.status || err.statusCode;
  if (status) out.status = status;
  if (process.env.NODE_ENV !== 'production' && err.stack) {
    out.stack = sanitizeMessage(String(err.stack).split('\n').slice(0, 8).join('\n'));
  }
  return out; // deliberately NOT copying err.sql / err.sqlMessage
}

function redact(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (value instanceof Error) return serializeError(value);
  if (typeof value === 'string') return sanitizeMessage(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object') return value;
  if (Buffer.isBuffer(value)) return `[Buffer ${value.length} bytes]`;
  if (depth >= MAX_DEPTH) return '[Object]';
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (value instanceof Date) return value.toISOString();
  const out = {};
  for (const key of Object.keys(value)) {
    out[key] = (SENSITIVE_KEY.test(key) || EXACT_SENSITIVE_KEY.test(key)) ? '[REDACTED]' : redact(value[key], depth + 1);
  }
  return out;
}

// ---------- request context (request id, user id) ----------
function runWithContext(ctx, fn) { return store.run(ctx, fn); }
function getContext() { return store.getStore() || {}; }
function setContext(patch) {
  const ctx = store.getStore();
  if (ctx) Object.assign(ctx, patch);
}

// ---------- output ----------
function formatText(record) {
  const { time, level, msg, requestId, ...rest } = record;
  const extra = Object.keys(rest).length ? ' ' + util.inspect(rest, { depth: 4, breakLength: Infinity }) : '';
  const rid = requestId ? ` [${String(requestId).slice(0, 8)}]` : '';
  return `${time.slice(11, 23)} ${level.toUpperCase().padEnd(5)}${rid} ${msg}${extra}`;
}

function log(level, msg, fields) {
  if (!LEVELS[level] || LEVELS[level] < threshold()) return;
  const record = {
    ...getContext(),
    ...(fields && typeof fields === 'object' ? redact(fields) : {}),
    time: new Date().toISOString(),
    level,
    msg: sanitizeMessage(msg),
  };
  const line = process.env.NODE_ENV === 'production' ? JSON.stringify(record) : formatText(record);
  try { writer(level, line); } catch (_) { /* logging must never crash the app */ }
}

// ---------- console bridge ----------
// Existing code calls console.log/warn/error in many places. Installing the bridge (server start only)
// sends those through the same pipeline, so they gain request ids and redaction without editing every call.
let bridged = false;
function installConsoleBridge() {
  if (bridged) return;
  bridged = true;
  const levelFor = { log: 'info', info: 'info', debug: 'debug', warn: 'warn', error: 'error' };
  for (const method of Object.keys(levelFor)) {
    console[method] = (...args) => {
      const errors = args.filter((a) => a instanceof Error);
      const text = args
        .filter((a) => !(a instanceof Error))
        .map((a) => (typeof a === 'string' ? a : util.inspect(redact(a), { depth: 3, breakLength: Infinity })))
        .join(' ');
      log(levelFor[method], text || (errors[0] && errors[0].message) || '(no message)',
        errors.length ? { err: errors[0] } : undefined);
    };
  }
}

// Test helper: capture output instead of writing it.
function _setWriter(fn) { writer = fn || defaultWriter; }

module.exports = {
  debug: (msg, fields) => log('debug', msg, fields),
  info: (msg, fields) => log('info', msg, fields),
  warn: (msg, fields) => log('warn', msg, fields),
  error: (msg, fields) => log('error', msg, fields),
  log,
  redact,
  sanitizeMessage,
  serializeError,
  runWithContext,
  getContext,
  setContext,
  installConsoleBridge,
  _setWriter,
};