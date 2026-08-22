'use strict';

// v2.7 section 10 idempotency deduplication tests: key derivation, canonical
// content fingerprint, consumed-table semantics (by key AND by content), TTL
// expiry, bounded-entry cleanup, and the two consumed error codes.

const assert = require('assert');
const idempotency = require('../../server/validators/idempotency.validator');
const dispatchContract = require('../../shared/dispatch-contract');

function samplePlan(overrides = {}) {
  return {
    schema_version: 'dispatch_contract.v1',
    operation: 'text_to_image',
    api: 'image_generation',
    relation: 'new',
    arguments: { prompt: '画一只橘猫' },
    bindings: [],
    constraints: [],
    context_policy: 'independent',
    idempotency_key: '',
    ...overrides,
  };
}

function testDerivedKeyMatchesDispatchContractCanonicalKey() {
  const plan = samplePlan();
  assert.strictEqual(idempotency.deriveIdempotencyKey(plan), dispatchContract.idempotencyKeyFor(plan));
  assert.match(idempotency.deriveIdempotencyKey(plan), /^ep1-/);
}

function testContentFingerprintIgnoresIdempotencyKey() {
  const base = samplePlan();
  const withKey = samplePlan({ idempotency_key: 'ep1-whatever' });
  assert.strictEqual(idempotency.contentFingerprint(base), idempotency.contentFingerprint(withKey));
  assert.strictEqual(idempotency.contentFingerprint(base).length, 64, 'sha256 hex length');
}

function testContentFingerprintChangesWithPlanContent() {
  const a = idempotency.contentFingerprint(samplePlan());
  const b = idempotency.contentFingerprint(samplePlan({ arguments: { prompt: '画一只蓝猫' } }));
  assert.notStrictEqual(a, b);
}

function testConsumedByKeyReturnsOriginalResult() {
  const table = idempotency.createIdempotencyTable({ ttlMs: 60_000, maxEntries: 10 });
  const plan = samplePlan();
  const key = idempotency.deriveIdempotencyKey(plan);
  const fingerprint = idempotency.contentFingerprint(plan);
  const result = { jobId: 'job-1', status: 'completed' };

  assert.deepStrictEqual(table.check({ key, fingerprint }), { status: 'new' });
  assert.strictEqual(table.consume({ key, fingerprint, result }), true);
  const consumed = table.check({ key, fingerprint });
  assert.strictEqual(consumed.status, 'consumed');
  assert.strictEqual(consumed.matchedBy, 'key');
  assert.deepStrictEqual(consumed.result, result);
}

function testConsumedByContentHitsEvenWithDifferentKey() {
  const table = idempotency.createIdempotencyTable({ ttlMs: 60_000, maxEntries: 10 });
  const plan = samplePlan();
  const fingerprint = idempotency.contentFingerprint(plan);
  table.consume({ key: 'ep1-first-key', fingerprint, result: { jobId: 'job-1' } });
  // Replay with a different key but identical canonical content must be
  // detected by the content fingerprint (doc 10).
  const consumed = table.check({ key: 'ep1-different-key', fingerprint });
  assert.strictEqual(consumed.status, 'consumed');
  assert.strictEqual(consumed.matchedBy, 'content');
}

function testTtlExpiryAllowsResubmission() {
  const table = idempotency.createIdempotencyTable({ ttlMs: 60_000, maxEntries: 10 });
  const plan = samplePlan();
  const key = idempotency.deriveIdempotencyKey(plan);
  const fingerprint = idempotency.contentFingerprint(plan);
  table.consume({ key, fingerprint, result: { jobId: 'job-1' }, now: 1000 });
  assert.strictEqual(table.check({ key, fingerprint, now: 1000 + 59_000 }).status, 'consumed');
  assert.deepStrictEqual(table.check({ key, fingerprint, now: 1000 + 60_001 }), { status: 'new' });
}

function testBoundedTableEvictsOldestEntry() {
  const table = idempotency.createIdempotencyTable({ ttlMs: 60_000, maxEntries: 3 });
  const base = Date.now();
  for (let index = 1; index <= 4; index += 1) {
    const plan = samplePlan({ arguments: { prompt: `画第 ${index} 只猫` } });
    table.consume({
      key: `ep1-key-${index}`,
      fingerprint: idempotency.contentFingerprint(plan),
      result: { jobId: `job-${index}` },
      now: base + index,
    });
  }
  assert.strictEqual(table.size(), 3);
  // The oldest entry (key-1) must be evicted.
  assert.deepStrictEqual(table.check({ key: 'ep1-key-1', fingerprint: '', now: base + 5 }), { status: 'new' });
}

function testExecutionConsumedErrorShape() {
  const error = idempotency.executionConsumedError({ jobId: 'job-1' });
  assert.strictEqual(error.code, 'execution.consumed');
  assert.strictEqual(error.statusCode, 409);
  assert.deepStrictEqual(error.previousResult, { jobId: 'job-1' });
}

function testClarificationConsumedErrorShape() {
  const error = idempotency.clarificationConsumedError();
  assert.strictEqual(error.code, 'clarification.consumed');
  assert.strictEqual(error.statusCode, 409);
}

function testClarificationIdempotencyKeyTracksStateVersion() {
  const base = idempotency.clarificationIdempotencyKey('clarify-1', 1, 'abc');
  const next = idempotency.clarificationIdempotencyKey('clarify-1', 2, 'abc');
  assert.notStrictEqual(base, next, 'state_version bump must derive a new key');
  assert.match(base, /^clr-clarify-1:1:abc$/);
}

// Fingerprint-index lifecycle (regression: content dedup must stay correct
// now that check() resolves fingerprints through a secondary index instead
// of a full table scan).
function testFingerprintIndexExpiresWithTtl() {
  const table = idempotency.createIdempotencyTable({ ttlMs: 1000, maxEntries: 10 });
  table.consume({ key: 'ep1-a', fingerprint: 'fp-1', result: { jobId: 'job-1' }, now: 1000 });
  assert.strictEqual(table.check({ key: 'ep1-b', fingerprint: 'fp-1', now: 1500 }).status, 'consumed');
  // After TTL expiry the indexed mapping must not keep reporting consumed.
  assert.deepStrictEqual(table.check({ key: 'ep1-b', fingerprint: 'fp-1', now: 2001 }), { status: 'new' });
  // Re-consuming the same content under a new key re-indexes the fingerprint.
  table.consume({ key: 'ep1-b', fingerprint: 'fp-1', result: { jobId: 'job-2' }, now: 2001 });
  const consumed = table.check({ key: 'ep1-c', fingerprint: 'fp-1', now: 2500 });
  assert.strictEqual(consumed.status, 'consumed');
  assert.deepStrictEqual(consumed.result, { jobId: 'job-2' });
}

function testFingerprintIndexRehomesAfterDuplicateKeyExpiry() {
  const table = idempotency.createIdempotencyTable({ ttlMs: 1000, maxEntries: 10 });
  // Same canonical content consumed under two different keys: the index keeps
  // first-match (oldest) semantics while both entries are live.
  table.consume({ key: 'ep1-first', fingerprint: 'fp-dup', result: { jobId: 'job-1' }, now: 1000 });
  table.consume({ key: 'ep1-second', fingerprint: 'fp-dup', result: { jobId: 'job-2' }, now: 1100 });
  const first = table.check({ key: 'ep1-third', fingerprint: 'fp-dup', now: 1200 });
  assert.strictEqual(first.status, 'consumed');
  assert.deepStrictEqual(first.result, { jobId: 'job-1' });
  // When the oldest entry expires, content matching must fall through to the
  // still-live duplicate instead of losing the fingerprint mapping.
  const afterExpiry = table.check({ key: 'ep1-third', fingerprint: 'fp-dup', now: 2001 });
  assert.strictEqual(afterExpiry.status, 'consumed');
  assert.deepStrictEqual(afterExpiry.result, { jobId: 'job-2' });
}

function testFingerprintIndexFollowsKeyReconsume() {
  const table = idempotency.createIdempotencyTable({ ttlMs: 60_000, maxEntries: 10 });
  table.consume({ key: 'ep1-key', fingerprint: 'fp-old', result: { jobId: 'job-1' } });
  // Re-consuming the same key with a new fingerprint must release the old
  // fingerprint mapping and index the new one.
  table.consume({ key: 'ep1-key', fingerprint: 'fp-new', result: { jobId: 'job-2' } });
  assert.deepStrictEqual(table.check({ key: 'ep1-other', fingerprint: 'fp-old' }), { status: 'new' });
  const consumed = table.check({ key: 'ep1-other', fingerprint: 'fp-new' });
  assert.strictEqual(consumed.status, 'consumed');
  assert.deepStrictEqual(consumed.result, { jobId: 'job-2' });
}

// Perf gate for the O(n) regression: a content-miss check used to linearly
// scan every consumed entry (and sweep the whole table) on each execution.
// The check path must resolve both key and fingerprint through Map lookups
// only. Iteration is counted deterministically by instrumenting the Map
// prototype during the checks.
function testContentMissCheckDoesNotIterateConsumedTable() {
  const table = idempotency.createIdempotencyTable({ ttlMs: 60_000, maxEntries: 1000 });
  for (let index = 0; index < 50; index += 1) {
    table.consume({ key: `ep1-k${index}`, fingerprint: `fp-${index}`, result: { jobId: `job-${index}` } });
  }
  const originalValues = Map.prototype.values;
  const originalIterator = Map.prototype[Symbol.iterator];
  let valuesCalls = 0;
  let iteratorCalls = 0;
  Map.prototype.values = function countedValues(...args) {
    valuesCalls += 1;
    return originalValues.apply(this, args);
  };
  Map.prototype[Symbol.iterator] = function countedIterator(...args) {
    iteratorCalls += 1;
    return originalIterator.apply(this, args);
  };
  try {
    for (let index = 0; index < 5; index += 1) {
      assert.deepStrictEqual(table.check({ key: 'ep1-miss', fingerprint: 'fp-miss' }), { status: 'new' });
    }
    assert.strictEqual(valuesCalls, 0, 'content-miss check must not scan the consumed table');
    assert.strictEqual(iteratorCalls, 0, 'content-miss check must not iterate the consumed table');
  } finally {
    Map.prototype.values = originalValues;
    Map.prototype[Symbol.iterator] = originalIterator;
  }
}

module.exports = [
  testDerivedKeyMatchesDispatchContractCanonicalKey,
  testContentFingerprintIgnoresIdempotencyKey,
  testContentFingerprintChangesWithPlanContent,
  testConsumedByKeyReturnsOriginalResult,
  testConsumedByContentHitsEvenWithDifferentKey,
  testTtlExpiryAllowsResubmission,
  testBoundedTableEvictsOldestEntry,
  testExecutionConsumedErrorShape,
  testClarificationConsumedErrorShape,
  testClarificationIdempotencyKeyTracksStateVersion,
  testFingerprintIndexExpiresWithTtl,
  testFingerprintIndexRehomesAfterDuplicateKeyExpiry,
  testFingerprintIndexFollowsKeyReconsume,
  testContentMissCheckDoesNotIterateConsumedTable,
];
