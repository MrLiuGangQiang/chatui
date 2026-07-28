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

module.exports = { normalizeExtraHeaders };
