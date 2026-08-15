'use strict';

class AppError extends Error {
  constructor(message, options = {}) {
    super(message || 'Error', options.cause ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.statusCode = options.statusCode || options.status || 500;
    this.code = options.code || 'ERROR';
    if (options.detail !== undefined && options.detail !== null) this.detail = options.detail;
    if (options.headers && typeof options.headers === 'object') this.headers = options.headers;
  }
}

function errorPayload(message, code = 'ERROR', detail = null) {
  const error = { code, message };
  if (detail !== undefined && detail !== null) error.detail = detail;
  return { error };
}

function normalizeError(err, fallback = {}) {
  if (err instanceof AppError || err instanceof Error || (err && typeof err === 'object')) {
    return {
      statusCode: err.statusCode || err.status || fallback.statusCode || fallback.status || 500,
      message: err.message || fallback.message || 'Error',
      code: err.code || fallback.code || 'ERROR',
      detail: err.detail !== undefined ? err.detail : fallback.detail,
      headers: err.headers || fallback.headers || {},
      original: err,
    };
  }
  return {
    statusCode: fallback.statusCode || fallback.status || 500,
    message: err ? String(err) : (fallback.message || 'Error'),
    code: fallback.code || 'ERROR',
    detail: fallback.detail,
    headers: fallback.headers || {},
    original: err,
  };
}

function toErrorPayload(err, fallback = {}) {
  if (typeof err === 'string') return errorPayload(err, fallback.code || 'ERROR', fallback.detail);
  const normalized = normalizeError(err, fallback);
  return errorPayload(normalized.message, normalized.code, normalized.detail);
}

module.exports = { AppError, errorPayload, normalizeError, toErrorPayload };
