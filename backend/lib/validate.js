'use strict';
// Small input helpers shared by routes that take free-form profile/text fields.

// Optional text: undefined/null/'' -> null; non-string or too long -> throws a ValidationError.
class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
    this.code = 'VALIDATION_ERROR';
  }
}

function optionalText(value, max, label) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new ValidationError(`${label} must be text.`);
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > max) throw new ValidationError(`${label} must be at most ${max} characters.`);
  return trimmed;
}

function requiredText(value, max, label) {
  const text = optionalText(value, max, label);
  if (!text) throw new ValidationError(`${label} is required.`);
  return text;
}

// Optional coordinate pair: both missing -> nulls; otherwise both must be valid numbers in range.
function optionalCoordinates(latitude, longitude) {
  const missing = (v) => v === undefined || v === null || v === '';
  if (missing(latitude) && missing(longitude)) return { lat: null, lng: null };
  const lat = Number(latitude);
  const lng = Number(longitude);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
    throw new ValidationError('Invalid latitude or longitude values.');
  }
  return { lat, lng };
}

const positiveId = (value) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
};

function sendValidationError(res, err) {
  if (err instanceof ValidationError) {
    res.status(err.status).json({ error: err.message, code: err.code });
    return true;
  }
  return false;
}

module.exports = { ValidationError, optionalText, requiredText, optionalCoordinates, positiveId, sendValidationError };
