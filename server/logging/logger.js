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

function createFileWriter(filePath, {
  maxBytes = 20 * 1024 * 1024,
  rotations = 3,
  enabled = true,
  maxQueue = positiveInteger(process.env.CHATUI_LOG_QUEUE_MAX, 2048),
  maxQueueBytes = positiveInteger(process.env.CHATUI_LOG_QUEUE_MAX_BYTES, 8 * 1024 * 1024),
  batchItems = positiveInteger(process.env.CHATUI_LOG_BATCH_MAX_ITEMS, 64),
  batchBytes = positiveInteger(process.env.CHATUI_LOG_BATCH_MAX_BYTES, 256 * 1024),
  onError = null,
  onDrop = null,
} = {}) {
  const resolvedFile = path.resolve(filePath);
  const queue = [];
  const waiters = [];
  const boundedMaxBytes = Math.max(1, Number(maxBytes) || 1);
  const boundedRotations = Math.max(0, Number(rotations) || 0);
  const boundedMaxQueue = Math.max(1, Number(maxQueue) || 1);
  const boundedMaxQueueBytes = Math.max(1, Number(maxQueueBytes) || 1);
  const boundedBatchItems = Math.max(1, Number(batchItems) || 1);
  const boundedBatchBytes = Math.max(1, Number(batchBytes) || 1);
  let queuedBytes = 0;
  let currentBytes = 0;
  let initialized = false;
  let initializePromise = null;
  let draining = false;
  let scheduled = false;
  let accepting = !!enabled;
  let dropped = 0;
  let failed = 0;
  let lastError = null;

  function stats() {
    return Object.freeze({
      pending: queue.length,
      queued_bytes: queuedBytes,
      dropped,
      failed,
      current_bytes: currentBytes,
      last_error: lastError ? String(lastError.message || lastError) : '',
    });
  }

  function notifyWaiters() {
    if (draining || scheduled || queue.length) return;
    const result = stats();
    while (waiters.length) waiters.shift()(result);
  }

  function reportError(error, phase, count = 1) {
    lastError = error;
    failed += Math.max(1, Number(count) || 1);
    try { onError?.(error, { phase, filePath: resolvedFile }); } catch {}
  }

  function reportDrop(entry) {
    dropped += 1;
    try { onDrop?.({ filePath: resolvedFile, bytes: Number(entry?.bytes) || 0, dropped }); } catch {}
  }

  async function ensureInitialized() {
    if (initialized) return;
    if (!initializePromise) {
      initializePromise = (async () => {
        await fs.promises.mkdir(path.dirname(resolvedFile), { recursive: true });
        try {
          currentBytes = Number((await fs.promises.stat(resolvedFile)).size) || 0;
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
          currentBytes = 0;
        }
        initialized = true;
      })().catch(error => {
        initializePromise = null;
        throw error;
      });
    }
    await initializePromise;
  }

  async function rotateIfNeeded(incomingBytes) {
    if (currentBytes + incomingBytes <= boundedMaxBytes) return;
    if (boundedRotations === 0) {
      await fs.promises.writeFile(resolvedFile, '', 'utf8');
      currentBytes = 0;
      return;
    }
    for (let index = boundedRotations; index >= 1; index -= 1) {
      const source = index === 1 ? resolvedFile : `${resolvedFile}.${index - 1}`;
      const target = `${resolvedFile}.${index}`;
      await fs.promises.rm(target, { force: true });
      try {
        await fs.promises.rename(source, target);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    currentBytes = 0;
  }

  function takeBatch() {
    let bytes = 0;
    const batch = [];
    for (const entry of queue) {
      if (batch.length >= boundedBatchItems) break;
      const exceedsBatch = batch.length > 0 && bytes + entry.bytes > boundedBatchBytes;
      const exceedsFile = batch.length > 0 && currentBytes + bytes + entry.bytes > boundedMaxBytes;
      if (exceedsBatch || exceedsFile) break;
      batch.push(entry);
      bytes += entry.bytes;
      if (entry.bytes > boundedMaxBytes) break;
    }
    if (!batch.length) {
      batch.push(queue[0]);
      bytes = queue[0].bytes;
    }
    queue.splice(0, batch.length);
    queuedBytes = Math.max(0, queuedBytes - bytes);
    return { batch, bytes };
  }

  function scheduleDrain() {
    if (!enabled || scheduled || draining || !queue.length) return;
    scheduled = true;
    setImmediate(() => {
      scheduled = false;
      void drain();
    });
  }

  async function drain() {
    if (!enabled || draining) return;
    draining = true;
    try {
      try {
        await ensureInitialized();
      } catch (error) {
        const droppedEntries = queue.splice(0, queue.length);
        queuedBytes = 0;
        for (const entry of droppedEntries) reportDrop(entry);
        reportError(error, 'initialize', droppedEntries.length || 1);
        return;
      }
      while (queue.length) {
        const { batch, bytes } = takeBatch();
        try {
          await rotateIfNeeded(bytes);
          await fs.promises.appendFile(resolvedFile, batch.map(entry => entry.line).join(''), 'utf8');
          currentBytes += bytes;
        } catch (error) {
          reportError(error, 'append', batch.length);
        }
      }
    } finally {
      draining = false;
      notifyWaiters();
      if (queue.length) scheduleDrain();
    }
  }

  function writeLine(json) {
    if (!enabled || !accepting) return false;
    let line;
    try {
      line = `${JSON.stringify(json)}\n`;
    } catch (error) {
      lastError = error;
      failed += 1;
      return false;
    }
    const bytes = Buffer.byteLength(line, 'utf8');
    if (queue.length >= boundedMaxQueue || queuedBytes + bytes > boundedMaxQueueBytes) {
      reportDrop({ bytes });
      return false;
    }
    queue.push({ line, bytes });
    queuedBytes += bytes;
    scheduleDrain();
    return true;
  }

  function flush() {
    if (!enabled || (!queue.length && !draining && !scheduled)) return Promise.resolve(stats());
    scheduleDrain();
    return new Promise(resolve => waiters.push(resolve));
  }

  async function close() {
    accepting = false;
    return flush();
  }

  return {
    writeLine,
    flush,
    close,
    stats,
    filePath: resolvedFile,
    enabled: !!enabled,
  };
}
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
