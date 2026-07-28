function normalizeOrigin(value = '') {
  try {
    const url = new URL(String(value || '').trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return '';
    return url.origin;
  } catch {
    return '';
  }
}

function configuredOrigins(env = process.env) {
  const raw = String(env.CHATUI_ALLOWED_ORIGINS || '').trim();
  const values = raw.split(/[\s,]+/).map(normalizeOrigin).filter(Boolean);
  return new Set(values);
}

function requestOrigin(req) {
  const host = String(req?.headers?.host || '').trim();
  if (!host || /[\r\n]/.test(host)) return '';
  const protocol = req?.socket?.encrypted ? 'https' : 'http';
  return normalizeOrigin(`${protocol}://${host}`);
}

function evaluateCorsRequest(req, env = process.env) {
  const rawOrigin = String(req?.headers?.origin || '').trim();
  if (!rawOrigin) return { allowed: true, responseOrigin: '' };
  const origin = normalizeOrigin(rawOrigin);
  if (!origin) return { allowed: false, responseOrigin: '' };
  if (env.CHATUI_ALLOW_ANY_ORIGIN === '1' || String(env.CHATUI_ALLOWED_ORIGINS || '').split(/[\s,]+/).includes('*')) {
    return { allowed: true, responseOrigin: '*' };
  }
  if (configuredOrigins(env).has(origin)) return { allowed: true, responseOrigin: origin };
  if (origin === requestOrigin(req)) return { allowed: true, responseOrigin: origin };
  return { allowed: false, responseOrigin: '' };
}

function applyCorsRequestContext(req, res, env = process.env) {
  const result = evaluateCorsRequest(req, env);
  Object.defineProperty(res, 'chatuiCorsOrigin', {
    configurable: true,
    enumerable: false,
    writable: true,
    value: result.responseOrigin,
  });
  return result;
}

module.exports = { normalizeOrigin, configuredOrigins, requestOrigin, evaluateCorsRequest, applyCorsRequestContext };
