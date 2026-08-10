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

function createIdempotencyTable(options = {}) {
  const ttlMs = Number(options.ttlMs || IDEMPOTENCY_TTL_MS);
  const maxEntries = Number(options.maxEntries || MAX_IDEMPOTENCY_ENTRIES);
  const table = new Map(); // key -> { fingerprint, result, consumedAt }

  function sweep(now = Date.now()) {
    for (const [key, entry] of table) {
      if (now - entry.consumedAt > ttlMs) table.delete(key);
    }
    while (table.size > maxEntries) {
      let oldestKey = null;
      let oldestAt = Infinity;
      for (const [key, entry] of table) {
        if (entry.consumedAt < oldestAt) { oldestAt = entry.consumedAt; oldestKey = key; }
      }
      if (!oldestKey) break;
      table.delete(oldestKey);
    }
  }

  // Returns { status: 'consumed', result } when the key OR the canonical
  // content fingerprint is already consumed, otherwise { status: 'new' }.
  function check({ key = '', fingerprint = '', now = Date.now() } = {}) {
    sweep(now);
    const byKey = table.get(String(key || ''));
    if (byKey) return Object.freeze({ status: 'consumed', result: byKey.result, matchedBy: 'key' });
    if (fingerprint) {
      for (const entry of table.values()) {
        if (entry.fingerprint === fingerprint) {
          return Object.freeze({ status: 'consumed', result: entry.result, matchedBy: 'content' });
        }
      }
    }
    return Object.freeze({ status: 'new' });
  }

  function consume({ key = '', fingerprint = '', result = null, now = Date.now() } = {}) {
    sweep(now);
    const normalizedKey = String(key || '');
    if (!normalizedKey) return false;
    table.set(normalizedKey, {
      fingerprint: String(fingerprint || ''),
      result: result === undefined ? null : result,
      consumedAt: now,
    });
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
  });
}

function executionConsumedError(result = null) {
  const error = new Error('该请求已在其他页面完成，未重复执行。请刷新查看最新状态。');
  error.code = 'execution.consumed';
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
  clarificationIdempotencyKey,
  createIdempotencyTable,
  executionConsumedError,
  clarificationConsumedError,
};
