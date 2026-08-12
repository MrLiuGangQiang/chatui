'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// ---------------------------------------------------------------------------
// Shared helpers (extracted from request-trace.js so all loggers can reuse)
// ---------------------------------------------------------------------------

const SENSITIVE_KEY_RE = /api[_-]?key|authorization|token|secret|password|cookie|set-cookie/i;
const DATA_URL_RE = /data:[^\s"'<>`]+;base64,[A-Za-z0-9+/=\r\n]+/g;
const BARE_BASE64_RE = /(?:iVBOR|\/9j\/|UklGR|R0lGOD)[A-Za-z0-9+/=\r\n]{4096,}/g;

function envFlag(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function positiveInteger(value, fallback, minimum = 1, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum) return fallback;
  return Math.min(maximum, Math.floor(parsed));
}

function nowMs() {
  const hr = process.hrtime();
  return Date.now() * 1000 + Math.floor(hr[1] / 1000) - Math.floor(hr[0] * 1000);
}

// Simplified: just use Date.now() for consistency
const now = () => Date.now();

function traceId() {
  return `trace-${crypto.randomBytes(6).toString('hex')}`;
}

function sanitizeTarget(value = '') {
  try {
    const url = new URL(String(value || ''));
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return redactString(String(value || '')).split('?')[0].split('#')[0];
  }
}

// ---------------------------------------------------------------------------
// Value redaction
// ---------------------------------------------------------------------------

function redactString(value = '') {
  return String(value || '')
    .replace(DATA_URL_RE, '[data-url-redacted]')
    .replace(BARE_BASE64_RE, '[base64-redacted]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1[redacted]')
    .replace(/(sk-[A-Za-z0-9_-]{8})[A-Za-z0-9_-]+/g, '$1...[redacted]');
}

function redactValue(value, depth = 0, key = '') {
  if (SENSITIVE_KEY_RE.test(String(key || ''))) return '[redacted]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value !== 'object') return value;
  if (depth >= 4) return Array.isArray(value) ? `[array:${value.length}]` : '[object]';
  if (Array.isArray(value)) return value.slice(0, 50).map(item => redactValue(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([itemKey, itemValue]) => [itemKey, redactValue(itemValue, depth + 1, itemKey)])
  );
}

function normalizeSecrets(values = []) {
  return [...new Set(
    (Array.isArray(values) ? values : [values])
      .map(value => String(value || ''))
      .filter(value => value.length >= 4)
  )];
}

function redactWithSecrets(value = '', secrets = []) {
  let text = String(value || '');
  for (const secret of normalizeSecrets(secrets)) text = text.split(secret).join('[redacted]');
  return redactString(text);
}

// ---------------------------------------------------------------------------
// File-based NDJSON writer with rotation
// ---------------------------------------------------------------------------

function resolveFilePath(relativePath, root = process.cwd()) {
  const resolved = path.resolve(String(root || process.cwd()), String(relativePath || ''));
  return resolved;
}

function createFileWriter(filePath, { maxBytes = 20 * 1024 * 1024, rotations = 3, enabled = true } = {}) {
  const resolvedFile = path.resolve(filePath);

  function rotate(incomingBytes) {
    let currentBytes;
    try { currentBytes = fs.statSync(resolvedFile).size; }
    catch (error) { if (error?.code !== 'ENOENT') throw error; currentBytes = 0; }
    if (currentBytes + incomingBytes <= maxBytes) return;
    if (rotations === 0) {
      fs.writeFileSync(resolvedFile, '', 'utf8');
      return;
    }
    for (let index = rotations; index >= 1; index -= 1) {
      const source = index === 1 ? resolvedFile : `${resolvedFile}.${index - 1}`;
      const target = `${resolvedFile}.${index}`;
      if (!fs.existsSync(source)) continue;
      if (index === rotations && fs.existsSync(target)) fs.rmSync(target, { force: true });
      fs.renameSync(source, target);
    }
  }

  function writeLine(json) {
    if (!enabled) return false;
    try {
      const dir = path.dirname(resolvedFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const line = `${JSON.stringify(json)}\n`;
      rotate(Buffer.byteLength(line, 'utf8'));
      fs.appendFileSync(resolvedFile, line, 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  return { writeLine, filePath: resolvedFile, enabled };
}

// ---------------------------------------------------------------------------
// Trace context (for call-chain correlation)
// ---------------------------------------------------------------------------

function createTraceContext(parentSpan = null) {
  const rootId = parentSpan?.root_trace_id || parentSpan?.traceId || traceId();
  const parentId = parentSpan?.traceId || null;
  const id = traceId();
  return Object.freeze({ traceId: id, parentTraceId: parentId, rootTraceId: rootId });
}

// ---------------------------------------------------------------------------
// Structured error serialisation
// ---------------------------------------------------------------------------

function serialiseError(err) {
  if (!err) return { message: 'Unknown error' };
  return {
    name: String(err.name || 'Error'),
    message: String(err.message || ''),
    code: String(err.code || err.cause?.code || ''),
    statusCode: Number(err.statusCode) || 0,
    stack: String(err.stack || '').split('\n').slice(0, 20).map(s => s.trim()),
  };
}

module.exports = {
  envFlag,
  positiveInteger,
  now,
  traceId,
  sanitizeTarget,
  redactString,
  redactValue,
  normalizeSecrets,
  redactWithSecrets,
  resolveFilePath,
  createFileWriter,
  createTraceContext,
  serialiseError,
  SENSITIVE_KEY_RE,
};
