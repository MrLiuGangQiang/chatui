const { errorPayload, normalizeError, toErrorPayload } = require('../errors/http-error');
const { responseCorsHeaders } = require('./cors');

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' https://registry.npmmirror.com https://cdn.jsdelivr.net 'unsafe-inline' blob:",
    "style-src 'self' https://registry.npmmirror.com https://cdn.jsdelivr.net 'unsafe-inline'",
    "font-src 'self' https://registry.npmmirror.com https://cdn.jsdelivr.net data:",
    "img-src 'self' data: blob: http: https:",
    "connect-src 'self' http: https: data: blob:",
    "media-src 'self' data: blob:",
    "object-src 'none'",
    "base-uri 'self'",
  ].join('; '),
};

function withoutCallerCorsHeaders(headers = {}) {
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !String(key).toLowerCase().startsWith('access-control-')));
}

function responseHeaders(res, headers = {}) {
  return { ...SECURITY_HEADERS, ...withoutCallerCorsHeaders(headers), ...responseCorsHeaders(res) };
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, responseHeaders(res, headers));
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

module.exports = { SECURITY_HEADERS, withoutCallerCorsHeaders, responseHeaders, send, sendJson, sendError, sendMethodNotAllowed };
