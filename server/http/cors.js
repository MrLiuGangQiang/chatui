const CORS_HEADERS = Symbol.for('chatui.corsHeaders');

function normalizeOrigin(value) {
  const raw = String(value || '').trim();
  if (!raw || raw === 'null') return '';
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return '';
    return url.origin;
  } catch {
    return '';
  }
}

function parseAllowedOrigins(value, errors = [], key = 'CHATUI_CORS_ORIGINS') {
  const raw = String(value || '').trim();
  if (!raw) return Object.freeze([]);
  const origins = [];
  const seen = new Set();
  for (const item of raw.split(',')) {
    const candidate = item.trim();
    const origin = normalizeOrigin(candidate);
    if (!origin) {
      errors.push(`${key} must be a comma-separated list of absolute HTTP(S) origins without paths.`);
      continue;
    }
    if (!seen.has(origin)) {
      seen.add(origin);
      origins.push(origin);
    }
  }
  return Object.freeze(origins);
}

function createCorsPolicy({ origins = [] } = {}) {
  const allowedOrigins = new Set(origins.map(normalizeOrigin).filter(Boolean));

  function headersFor(req) {
    const origin = normalizeOrigin(req?.headers?.origin);
    if (!origin || !allowedOrigins.has(origin)) return {};
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Request-Id',
      'Access-Control-Max-Age': '600',
      Vary: 'Origin',
    };
  }

  return Object.freeze({
    allowedOrigins: Object.freeze([...allowedOrigins]),
    isAllowed(origin) {
      const normalized = normalizeOrigin(origin);
      return !!normalized && allowedOrigins.has(normalized);
    },
    headersFor,
  });
}

function setResponseCorsHeaders(res, headers = {}) {
  if (res && typeof res === 'object') res[CORS_HEADERS] = headers;
  return headers;
}

function responseCorsHeaders(res) {
  return res?.[CORS_HEADERS] || {};
}

function applyCorsPolicy(req, res, policy) {
  const origin = normalizeOrigin(req?.headers?.origin);
  const allowed = !origin || !!policy?.isAllowed(origin);
  const headers = origin && allowed ? policy.headersFor(req) : {};
  setResponseCorsHeaders(res, headers);
  return { origin, allowed, headers };
}

module.exports = {
  CORS_HEADERS,
  normalizeOrigin,
  parseAllowedOrigins,
  createCorsPolicy,
  setResponseCorsHeaders,
  responseCorsHeaders,
  applyCorsPolicy,
};
