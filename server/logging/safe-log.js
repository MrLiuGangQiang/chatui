const SENSITIVE_KEY_RE = /api[_-]?key|authorization|token|secret|password|cookie|set-cookie/i;
const DATA_URL_RE = /data:[^\s"'<>`]+;base64,[A-Za-z0-9+/=\r\n]+/g;
const BARE_BASE64_RE = /(?:iVBOR|\/9j\/|UklGR|R0lGOD)[A-Za-z0-9+/=\r\n]{4096,}/g;

function redactString(value = '') {
  return String(value || '')
    .replace(DATA_URL_RE, '[data-url-redacted]')
    .replace(BARE_BASE64_RE, '[base64-redacted]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1[redacted]')
    .replace(/(sk-[A-Za-z0-9_-]{8})[A-Za-z0-9_-]+/g, '$1...[redacted]');
}

function redactUrl(value = '') {
  try {
    const url = new URL(String(value || ''), 'http://localhost');
    if ([...url.searchParams.keys()].length) url.search = '?[redacted]';
    return url.pathname + url.search;
  } catch {
    return redactString(value).split('?')[0] + (String(value || '').includes('?') ? '?[redacted]' : '');
  }
}

function redactValue(value, depth = 0, key = '') {
  if (SENSITIVE_KEY_RE.test(String(key || ''))) return '[redacted]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value !== 'object') return value;
  if (depth >= 4) return Array.isArray(value) ? `[array:${value.length}]` : '[object]';
  if (Array.isArray(value)) return value.slice(0, 50).map(item => redactValue(item, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([itemKey, itemValue]) => [itemKey, redactValue(itemValue, depth + 1, itemKey)]));
}

function shouldLogVerbose() {
  return process.env.CHATUI_VERBOSE_LOGS === '1' || process.env.DEBUG_CHATUI === '1';
}

function safeLog(label, payload = {}, options = {}) {
  if (!options.always && !shouldLogVerbose()) return;
  const redacted = redactValue(payload);
  console.log(label, typeof redacted === 'string' ? redacted : JSON.stringify(redacted));
}

module.exports = { safeLog, redactValue, redactString, redactUrl, shouldLogVerbose };
