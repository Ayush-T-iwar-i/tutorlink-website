'use strict';
// Request id, uniform error responses and request logging.
//
//   requestContext   - FIRST middleware: assigns req.id, sets X-Request-Id, makes every error response
//                      (status >= 400) share one JSON shape, logs each API request when it finishes.
//   bindLogContext   - after the body parsers: attaches the request id to every log line written while
//                      the request is handled (body parsing happens outside Node's async context,
//                      so this has to run after it).
//   apiNotFound / errorHandler - LAST middleware.
//
// Error shape (message and error are the same text; `error` is kept so the existing frontend works):
//   { success: false, message, error, code, requestId, ...any extra fields the route added }

const crypto = require('crypto');
const multer = require('multer');
const logger = require('../lib/logger');

const ID_RE = /^[A-Za-z0-9._-]{8,64}$/;

const DEFAULT_CODES = {
  400: 'BAD_REQUEST', 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 405: 'METHOD_NOT_ALLOWED',
  409: 'CONFLICT', 413: 'PAYLOAD_TOO_LARGE', 415: 'UNSUPPORTED_MEDIA_TYPE', 422: 'VALIDATION_ERROR',
  423: 'LOCKED', 429: 'RATE_LIMITED', 500: 'INTERNAL_ERROR', 502: 'GATEWAY_ERROR',
  503: 'SERVICE_UNAVAILABLE', 504: 'GATEWAY_TIMEOUT',
};

function defaultCode(status) {
  return DEFAULT_CODES[status] || (status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_FAILED');
}

function defaultMessage(status) {
  return status >= 500 ? 'Something went wrong on our end.' : 'The request could not be completed.';
}

function normalizeError(status, body, requestId) {
  const text = [body.message, body.error].find((v) => typeof v === 'string' && v.trim());
  const message = text || defaultMessage(status);
  return {
    ...body,
    success: false,
    message,
    error: message,
    code: typeof body.code === 'string' && body.code ? body.code : defaultCode(status),
    requestId,
  };
}

function requestContext(req, res, next) {
  const supplied = req.get('x-request-id');
  const id = supplied && ID_RE.test(supplied) ? supplied : crypto.randomUUID();
  req.id = id;
  res.setHeader('X-Request-Id', id);
  const started = process.hrtime.bigint();

  // Make every error response look the same, whichever route produced it.
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode >= 400 && body && typeof body === 'object' && !Array.isArray(body)) {
      return originalJson(normalizeError(res.statusCode, body, id));
    }
    return originalJson(body);
  };

  res.on('finish', () => {
    // Log the route pattern (/api/x/:id) when known, and never the query string: both can hold ids or one-time tokens.
    const routePath = req.route && req.route.path && typeof req.route.path === 'string'
      ? (req.baseUrl || '') + req.route.path
      : String(req.originalUrl || req.url || '').split('?')[0];
    const status = res.statusCode;
    if (routePath === '/health') return;
    if (status < 400 && !routePath.startsWith('/api')) return; // static files
    const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
    logger.log(level, 'request', {
      requestId: id,
      userId: req.user && req.user.id,
      method: req.method,
      path: routePath,
      status,
      durationMs: Math.round(Number(process.hrtime.bigint() - started) / 1e4) / 100,
      ip: req.ip,
    });
  });

  next();
}

function bindLogContext(req, res, next) {
  logger.runWithContext({ requestId: req.id }, next);
}

function apiNotFound(req, res) {
  res.status(404).json({ error: 'API route not found.', code: 'NOT_FOUND' });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  let status = 500;
  let code = 'INTERNAL_ERROR';
  let message = 'Something went wrong on our end.';
  let expected = true;

  if (err instanceof multer.MulterError) {
    status = 400;
    if (err.code === 'LIMIT_FILE_SIZE') {
      code = 'FILE_TOO_LARGE';
      message = 'Uploaded file is too large (max limit exceeded).';
    } else {
      code = 'UPLOAD_ERROR';
      message = `Upload error: ${err.message}`;
    }
  } else if (err && (err.code === 'INVALID_FILE_TYPE' || (typeof err.message === 'string' && err.message.includes('Only JPG, PNG')))) {
    status = 400;
    code = 'INVALID_FILE_TYPE';
    message = err.message;
  } else if (err && err.type === 'entity.parse.failed') {
    status = 400;
    code = 'BAD_JSON';
    message = 'The request body is not valid JSON.';
  } else if (err && err.type === 'entity.too.large') {
    status = 413;
    code = 'PAYLOAD_TOO_LARGE';
    message = 'The request body is too large.';
  } else if (err && (err.type === 'encoding.unsupported' || err.type === 'charset.unsupported')) {
    status = 415;
    code = 'UNSUPPORTED_MEDIA_TYPE';
    message = 'Unsupported request encoding.';
  } else if (err && err.type === 'request.aborted') {
    status = 400;
    code = 'REQUEST_ABORTED';
    message = 'The request was cancelled before it finished.';
  } else if (err && Number.isInteger(err.status || err.statusCode) && (err.status || err.statusCode) >= 400 && (err.status || err.statusCode) < 500) {
    // A client error raised by a library (for example http-errors): keep its status. Its message is
    // shown only when the library marks it safe to expose.
    status = err.status || err.statusCode;
    code = defaultCode(status);
    message = err.expose && err.message ? String(err.message) : defaultMessage(status);
  } else {
    expected = false;
    const isDev = process.env.NODE_ENV === 'development';
    if (isDev && err && err.message) message = String(err.message);
  }

  if (!expected) {
    logger.error('Unhandled error', { requestId: req.id, method: req.method, err });
  }
  res.status(status).json({ error: message, code });
}

module.exports = { requestContext, bindLogContext, apiNotFound, errorHandler, normalizeError, defaultCode };