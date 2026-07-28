function normalizeExtraHeaders(headers = {}) {
  const out = {};
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return out;
  const blocked = new Set([
    'authorization', 'content-type', 'content-length', 'host', 'connection', 'transfer-encoding',
    'proxy-authorization', 'proxy-authenticate', 'proxy-connection', 'keep-alive', 'upgrade', 'trailer', 'te',
  ]);
  for (const [rawName, rawValue] of Object.entries(headers).slice(0, 64)) {
    const name = String(rawName || '').trim();
    if (!name || name.length > 128 || blocked.has(name.toLowerCase())) continue;
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) continue;
    if (rawValue === undefined || rawValue === null) continue;
    const value = Array.isArray(rawValue) ? rawValue.map(v => String(v)).join(', ') : String(rawValue);
    if (value.length > 8192 || /[\r\n\u0000]/.test(value)) continue;
    out[name] = value;
  }
  return out;
}

module.exports = { normalizeExtraHeaders };
