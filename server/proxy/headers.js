const { readVersion } = require('../version-source');

// ChatUI identifies every outbound upstream request with its release version so
// operators and gateways can see which client build is calling. version.json is
// the single version source, so the value can never drift from the running
// release.
const CHATUI_USER_AGENT = Object.freeze(`chatui/${readVersion()}`);

function normalizeExtraHeaders(headers = {}) {
  const out = {};
  const blocked = new Set(['authorization', 'content-type', 'content-length', 'host', 'connection', 'transfer-encoding']);
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = String(rawName || '').trim();
    if (!name || blocked.has(name.toLowerCase())) continue;
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) continue;
    if (rawValue === undefined || rawValue === null) continue;
    const value = Array.isArray(rawValue) ? rawValue.map(v => String(v)).join(', ') : String(rawValue);
    out[name] = value;
  }
  return out;
}

// Appends the ChatUI User-Agent to an outbound header map unless the caller
// already set one. Extra headers and auth headers are preserved as-is.
function withChatuiUserAgent(headers = {}) {
  const source = headers && typeof headers === 'object' ? headers : {};
  const out = { ...source };
  const hasUserAgent = Object.keys(out).some(name => String(name).toLowerCase() === 'user-agent');
  if (!hasUserAgent) out['User-Agent'] = CHATUI_USER_AGENT;
  return out;
}

module.exports = { normalizeExtraHeaders, CHATUI_USER_AGENT, withChatuiUserAgent };
