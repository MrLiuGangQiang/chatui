const { errorPayload, normalizeError, toErrorPayload } = require('../errors/http-error');

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' blob:",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' data: blob: http: https:",
    "connect-src 'self' http: https: data: blob:",
    "media-src 'self' data: blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'self'",
  ].join('; '),
};

function appendVary(value, field) {
  const fields = String(value || '').split(',').map(item => item.trim()).filter(Boolean);
  if (!fields.some(item => item.toLowerCase() === field.toLowerCase())) fields.push(field);
  return fields.join(', ');
}

function applyResponseHeaders(res, headers = {}) {
  const next = { ...headers };
  if (Object.prototype.hasOwnProperty.call(res || {}, 'chatuiCorsOrigin')) {
    const origin = String(res.chatuiCorsOrigin || '');
    if (!origin) delete next['Access-Control-Allow-Origin'];
    else {
      next['Access-Control-Allow-Origin'] = origin;
      if (origin !== '*') next.Vary = appendVary(next.Vary, 'Origin');
    }
  }
  return next;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, applyResponseHeaders(res, { ...SECURITY_HEADERS, ...headers }));
  res.end(body);
}

function sendJson(res, status, data, headers = {}) {
  send(res, status, JSON.stringify(data), { 'Content-Type': 'application/json; charset=utf-8', ...headers });
}

function isErrorLike(value) {
  return value instanceof Error || (value && typeof value === 'object' && ('message' in value || 'statusCode' in value || 'status' in value || 'code' in value));
}

function sendError(res, status, message, code = 'ERROR', detail = null, headers = {}) {
  if (isErrorLike(status)) {
    const fallback = message && typeof message === 'object'
      ? message
      : { message, code, detail, headers };
    const normalized = normalizeError(status, fallback);
    return sendJson(res, normalized.statusCode, toErrorPayload(status, fallback), { ...normalized.headers, ...(fallback.headers || {}) });
  }
  return sendJson(res, status, errorPayload(message, code, detail), headers);
}

function sendMethodNotAllowed(res) {
  return sendError(res, 405, 'Method Not Allowed', 'METHOD_NOT_ALLOWED');
}

module.exports = { SECURITY_HEADERS, appendVary, applyResponseHeaders, send, sendJson, sendError, sendMethodNotAllowed };
