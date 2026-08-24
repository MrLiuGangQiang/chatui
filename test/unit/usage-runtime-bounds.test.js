'use strict';

const assert = require('assert');
const {
  cacheKey,
  createUsageAccessValidator,
} = require('../../server/services/usage-access.service');
const usageValidator = require('../../server/validators/usage.validator');

function modelResponse(model = 'gpt-5') {
  return { ok: true, json: async () => ({ data: [{ id: model }] }) };
}

function requestFrom(ip) {
  return { headers: {}, socket: { remoteAddress: ip } };
}

async function testUsageAccessConcurrentValidationSharesOneUpstreamRequest() {
  let calls = 0;
  let release = null;
  const validator = createUsageAccessValidator({
    fetchImpl: () => {
      calls += 1;
      return new Promise(resolve => { release = () => resolve(modelResponse()); });
    },
  });
  const validations = Array.from({ length: 100 }, () => validator.validate('sk-shared', 'gpt-5'));
  assert.strictEqual(calls, 1, 'identical concurrent checks must share one upstream /models request');
  assert.deepStrictEqual(validator.stats(), { cache_entries: 0, in_flight: 1 });
  release();
  assert.deepStrictEqual(await Promise.all(validations), Array.from({ length: 100 }, () => ({ ok: true })));
  assert.strictEqual(calls, 1);
  assert.deepStrictEqual(validator.stats(), { cache_entries: 1, in_flight: 0 });
}

async function testUsageAccessCacheIsBoundedLruAndIncludesBaseUrl() {
  let now = 100;
  const calls = [];
  const validator = createUsageAccessValidator({
    now: () => now,
    maxEntries: 2,
    cacheTtlMs: 10_000,
    fetchImpl: async url => {
      calls.push(url);
      return modelResponse();
    },
  });
  await validator.validate('sk-one', 'gpt-5');
  await validator.validate('sk-two', 'gpt-5');
  await validator.validate('sk-one', 'gpt-5'); // refresh LRU order
  await validator.validate('sk-three', 'gpt-5');
  assert.deepStrictEqual(validator.stats(), { cache_entries: 2, in_flight: 0 });
  await validator.validate('sk-one', 'gpt-5');
  assert.strictEqual(calls.length, 3, 'the refreshed entry must survive LRU trimming');
  await validator.validate('sk-two', 'gpt-5');
  assert.strictEqual(calls.length, 4, 'the oldest entry must be evicted at the configured bound');

  await validator.validate('sk-two', 'gpt-5', { baseUrl: 'https://other.example/v1' });
  assert.strictEqual(calls.length, 5, 'the same credential/model pair at another endpoint must not reuse the wrong cache entry');
  assert.strictEqual(calls.at(-1), 'https://other.example/v1/models');

  const firstHash = cacheKey('https://one.example/v1', 'sk-secret-value', 'gpt-5');
  const secondHash = cacheKey('https://two.example/v1', 'sk-secret-value', 'gpt-5');
  assert.notStrictEqual(firstHash, secondHash);
  assert.doesNotMatch(firstHash, /sk-secret-value|one\.example/);
  now += 10_001;
  assert.deepStrictEqual(validator.stats(), { cache_entries: 0, in_flight: 0 });
}

async function testUsageAccessInFlightMapIsBoundedAndFailuresAreReleased() {
  const releases = [];
  let calls = 0;
  const validator = createUsageAccessValidator({
    maxInFlight: 2,
    fetchImpl: () => {
      calls += 1;
      return new Promise(resolve => releases.push(() => resolve(modelResponse())));
    },
  });
  const first = validator.validate('sk-a', 'gpt-5');
  const second = validator.validate('sk-b', 'gpt-5');
  assert.deepStrictEqual(await validator.validate('sk-c', 'gpt-5'), {
    ok: false,
    statusCode: 503,
    code: 'MODEL_VALIDATION_BUSY',
    message: '验证请求过多，请稍后重试统计或反馈',
  });
  assert.strictEqual(calls, 2);
  assert.strictEqual(validator.stats().in_flight, 2);
  releases.splice(0).forEach(release => release());
  await Promise.all([first, second]);
  assert.strictEqual(validator.stats().in_flight, 0);

  let outageCalls = 0;
  const outage = createUsageAccessValidator({
    fetchImpl: async () => {
      outageCalls += 1;
      throw new Error('offline');
    },
  });
  const results = await Promise.all([
    outage.validate('sk-outage', 'gpt-5'),
    outage.validate('sk-outage', 'gpt-5'),
  ]);
  assert.strictEqual(outageCalls, 1);
  assert.ok(results.every(result => result.code === 'MODEL_VALIDATION_UNAVAILABLE'));
  await outage.validate('sk-outage', 'gpt-5');
  assert.strictEqual(outageCalls, 2, 'failed validation must leave in-flight state retryable');
}

function testUsageRateLimitSweepsExpiredBucketsAcrossOtherClients() {
  const buckets = new Map([
    ['rankings:expired-a', { count: 1, resetAt: 50 }],
    ['rankings:expired-b', { count: 1, resetAt: 75 }],
    ['rankings:live', { count: 1, resetAt: 500 }],
  ]);
  const result = usageValidator.checkUsageRefreshLimit(requestFrom('new-client'), 'rankings', {
    buckets,
    limit: 2,
    windowMs: 1000,
    maxBuckets: 10,
    sweepIntervalMs: 1,
    now: 100,
  });
  assert.strictEqual(result.allowed, true);
  assert.deepStrictEqual([...buckets.keys()].sort(), ['rankings:live', 'rankings:new-client']);
}

function testUsageRateLimitMapEvictsOldestBucketsAtTheHardBound() {
  const buckets = new Map();
  for (let index = 0; index < 10; index += 1) {
    const result = usageValidator.checkUsageRefreshLimit(requestFrom(`client-${index}`), 'overview', {
      buckets,
      limit: 2,
      windowMs: 10_000,
      maxBuckets: 3,
      sweepIntervalMs: 10_000,
      now: index + 1,
    });
    assert.strictEqual(result.allowed, true);
    assert.ok(buckets.size <= 3, 'rate-limit storage must never exceed the configured hard bound');
  }
  assert.deepStrictEqual([...buckets.keys()], [
    'overview:client-7',
    'overview:client-8',
    'overview:client-9',
  ]);
}

module.exports = [
  testUsageAccessConcurrentValidationSharesOneUpstreamRequest,
  testUsageAccessCacheIsBoundedLruAndIncludesBaseUrl,
  testUsageAccessInFlightMapIsBoundedAndFailuresAreReleased,
  testUsageRateLimitSweepsExpiredBucketsAcrossOtherClients,
  testUsageRateLimitMapEvictsOldestBucketsAtTheHardBound,
];