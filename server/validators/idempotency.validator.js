'use strict';

// Design doc v2.7 section 10: idempotency deduplication.
// The client derives the idempotency key; the server double-checks by key AND
// by canonical request content. A consumed entry returns the original result
// or a duplicate-submit state instead of executing twice. Consumed records
// live in a bounded in-memory table (single-user internal tool; the existing
// Job table remains the durable execution record, this table only carries the
// consumed index for deduplication decisions).

const crypto = require('crypto');
const dispatchContract = require('../../shared/dispatch-contract');

const IDEMPOTENCY_TTL_MS = Number(process.env.IDEMPOTENCY_TTL_MS || 24 * 60 * 60 * 1000);
const MAX_IDEMPOTENCY_ENTRIES = Number(process.env.MAX_IDEMPOTENCY_ENTRIES || 20000);

function planWithoutIdempotency(plan = {}) {
  const clone = { ...(plan || {}) };
  delete clone.idempotency_key;
  return clone;
}

// Canonical content fingerprint: independent of the client key so a replay
// with a different key still hits the consumed table (doc 10, "相同规范化请求
// 内容但 key 不同 → 同样命中已消费").
function contentFingerprint(plan = {}) {
  const serialized = dispatchContract.stableStringify
    ? dispatchContract.stableStringify(planWithoutIdempotency(plan))
    : JSON.stringify(planWithoutIdempotency(plan));
  return crypto.createHash('sha256').update(String(serialized || '')).digest('hex');
}

function deriveIdempotencyKey(plan = {}) {
  return dispatchContract.idempotencyKeyFor
    ? dispatchContract.idempotencyKeyFor(plan)
    : `ep1-${contentFingerprint(plan).slice(0, 16)}`;
}

// Clarification-layer key (doc 10): clarify_id + ":" + state_version + ":"
// + choice/patch fingerprint. The same clarification with a changed selection
// increments state_version and derives a new key, which is a legal operation.
function clarificationIdempotencyKey(clarifyId = '', stateVersion = 0, selectionFingerprint = '') {
  return `clr-${String(clarifyId || '')}:${Number(stateVersion) || 0}:${String(selectionFingerprint || '').slice(0, 32)}`;
}

function executionIdempotencyScope(ownerScope = '', submissionId = '', fallbackId = '') {
  const owner = String(ownerScope || '').trim();
  const submission = String(submissionId || fallbackId || '').trim();
  return `${owner}:${submission}`;
}

function scopedKey(scope = '', value = '') {
  return `${String(scope || '')}\0${String(value || '')}`;
}

function createIdempotencyTable(options = {}) {
  const ttlMs = Number(options.ttlMs || IDEMPOTENCY_TTL_MS);
  const maxEntries = Number(options.maxEntries || MAX_IDEMPOTENCY_ENTRIES);
  const table = new Map(); // physical key -> { logicalKey, scope, fingerprint, result, consumedAt }
  const keyIndex = new Map(); // scoped logical idempotency key -> physical key
  // Secondary index keeps content-fingerprint dedup O(1). Without it every
  // execution check linearly scans up to maxEntries rows. The index maps a
  // fingerprint to the oldest live key holding it, preserving the previous
  // first-match semantics of the linear scan.
  const fingerprintIndex = new Map(); // fingerprint -> key

  function dropKey(key) {
    const entry = table.get(key);
    if (!entry) return;
    table.delete(key);
    if (entry.logicalKey && keyIndex.get(entry.logicalKey) === key) keyIndex.delete(entry.logicalKey);
    const fingerprintKey = scopedKey(entry.scope, entry.fingerprint);
    if (entry.fingerprint && fingerprintIndex.get(fingerprintKey) === key) {
      fingerprintIndex.delete(fingerprintKey);
      // Re-home the mapping to another live key with the same scoped fingerprint.
      for (const [otherKey, other] of table) {
        if (other.scope === entry.scope && other.fingerprint === entry.fingerprint) {
          fingerprintIndex.set(fingerprintKey, otherKey);
          break;
        }
      }
    }
  }

  function sweep(now = Date.now()) {
    for (const [key, entry] of table) {
      if (now - entry.consumedAt > ttlMs) dropKey(key);
    }
    while (table.size > maxEntries) {
      let oldestKey = null;
      let oldestAt = Infinity;
      for (const [key, entry] of table) {
        if (entry.consumedAt < oldestAt) { oldestAt = entry.consumedAt; oldestKey = key; }
      }
      if (!oldestKey) break;
      dropKey(oldestKey);
    }
  }

  function isExpired(entry, now) {
    return !entry || now - entry.consumedAt > ttlMs;
  }

  // Returns { status: 'consumed', result } when the key OR the canonical
  // content fingerprint is already consumed, otherwise { status: 'new' }.
  // Reads are O(1): TTL expiry is evaluated lazily for just the matched
  // entry, and the full-table sweep only runs on writes (consume) and size(),
  // which is also where the max-entries bound is enforced.
  function check({ key = '', fingerprint = '', scope = '', now = Date.now() } = {}) {
    const normalizedKey = String(key || '');
    const normalizedFingerprint = String(fingerprint || '');
    const logicalKey = scopedKey(scope, normalizedKey);
    const physicalKey = keyIndex.get(logicalKey);
    const byKey = physicalKey ? table.get(physicalKey) : null;
    if (byKey) {
      if (isExpired(byKey, now)) dropKey(physicalKey);
      else if (normalizedFingerprint && byKey.fingerprint !== normalizedFingerprint) {
        return Object.freeze({ status: 'conflict', result: byKey.result, matchedBy: 'key' });
      } else return Object.freeze({ status: 'consumed', result: byKey.result, matchedBy: 'key' });
    }
    if (normalizedFingerprint) {
      const fingerprintKey = scopedKey(scope, normalizedFingerprint);
      // Expired indexed entries are dropped lazily; dropKey re-homes the
      // mapping to another live key with the same scoped fingerprint.
      for (;;) {
        const indexedKey = fingerprintIndex.get(fingerprintKey);
        if (!indexedKey) break;
        const entry = table.get(indexedKey);
        if (!entry || entry.scope !== String(scope || '') || entry.fingerprint !== normalizedFingerprint) break;
        if (isExpired(entry, now)) {
          dropKey(indexedKey);
          continue;
        }
        return Object.freeze({ status: 'consumed', result: entry.result, matchedBy: 'content' });
      }
    }
    return Object.freeze({ status: 'new' });
  }

  function consume({ key = '', fingerprint = '', scope = '', result = null, now = Date.now() } = {}) {
    sweep(now);
    const normalizedKey = String(key || '');
    if (!normalizedKey) return false;
    const normalizedScope = String(scope || '');
    const normalizedFingerprint = String(fingerprint || '');
    const logicalKey = scopedKey(normalizedScope, normalizedKey);
    const existingPhysicalKey = keyIndex.get(logicalKey);
    if (existingPhysicalKey) dropKey(existingPhysicalKey);
    const physicalKey = scopedKey(normalizedScope, `${normalizedKey}\0${normalizedFingerprint}`);
    table.set(physicalKey, {
      logicalKey,
      scope: normalizedScope,
      fingerprint: normalizedFingerprint,
      result: result === undefined ? null : result,
      consumedAt: now,
    });
    keyIndex.set(logicalKey, physicalKey);
    const fingerprintKey = scopedKey(normalizedScope, normalizedFingerprint);
    if (normalizedFingerprint && !fingerprintIndex.has(fingerprintKey)) {
      fingerprintIndex.set(fingerprintKey, physicalKey);
    }
    return true;
  }

  function release({ key = '', fingerprint = '', scope = '', result = undefined } = {}) {
    const physicalKey = scopedKey(scope, `${String(key || '')}\0${String(fingerprint || '')}`);
    const entry = table.get(physicalKey);
    if (!entry) return false;
    if (fingerprint && entry.fingerprint !== String(fingerprint)) return false;
    if (result !== undefined && String(entry.result ?? '') !== String(result ?? '')) return false;
    dropKey(physicalKey);
    return true;
  }

  function size() {
    sweep();
    return table.size;
  }

  return Object.freeze({
    check,
    consume,
    size,
    sweep,
    release,
  });
}

function executionConsumedError(result = null) {
  const error = new Error('该请求已在其他页面完成，未重复执行。请刷新查看最新状态。');
  error.code = 'execution.consumed';
  error.statusCode = 409;
  if (result !== undefined && result !== null) error.previousResult = result;
  return error;
}

function executionIdempotencyConflictError(result = null) {
  const error = new Error('幂等键与请求内容冲突，请重新提交。');
  error.code = 'IDEMPOTENCY_KEY_CONFLICT';
  error.statusCode = 409;
  if (result !== undefined && result !== null) error.previousResult = result;
  return error;
}

function clarificationConsumedError() {
  const error = new Error('该澄清请求已处理，未重复提交。请刷新查看最新状态。');
  error.code = 'clarification.consumed';
  error.statusCode = 409;
  return error;
}

module.exports = {
  IDEMPOTENCY_TTL_MS,
  MAX_IDEMPOTENCY_ENTRIES,
  planWithoutIdempotency,
  contentFingerprint,
  deriveIdempotencyKey,
  executionIdempotencyScope,
  clarificationIdempotencyKey,
  createIdempotencyTable,
  executionConsumedError,
  executionIdempotencyConflictError,
  clarificationConsumedError,
};
