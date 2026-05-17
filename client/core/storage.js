function readJsonStorage(storage, key, fallback) {
  try {
    const raw = storage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    try { storage.removeItem(key); } catch {}
    return fallback;
  }
}

function safeSetJsonStorage(storage, key, value, options = {}) {
  const stringify = options.stringify || JSON.stringify;
  try {
    storage.setItem(key, stringify(value));
    return true;
  } catch (err) {
    if (typeof options.onQuotaError === 'function') options.onQuotaError(err);
    return false;
  }
}

function sessionStorageKey(baseKey, sessionId) {
  return `${baseKey}:${sessionId || 'default'}`;
}

function collectIndexedDbKeys(value, keys = new Set()) {
  if (!value) return keys;
  if (typeof value === 'string') {
    const re = /indexeddb:\/\/([^"'<>`\s]+)/g;
    let match;
    while ((match = re.exec(value))) keys.add(match[1]);
    return keys;
  }
  if (Array.isArray(value)) {
    value.forEach(item => collectIndexedDbKeys(item, keys));
    return keys;
  }
  if (typeof value === 'object') Object.values(value).forEach(item => collectIndexedDbKeys(item, keys));
  return keys;
}

module.exports = { readJsonStorage, safeSetJsonStorage, sessionStorageKey, collectIndexedDbKeys };
