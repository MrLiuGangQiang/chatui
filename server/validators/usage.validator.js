const crypto = require('crypto');
const { isDepartmentRange, isPersonalRange } = require('../usage/ranges');

const USAGE_REFRESH_LIMIT = 12;
const USAGE_REFRESH_WINDOW_MS = 60 * 1000;
const MAX_USAGE_REFRESH_BUCKETS = 4096;
const USAGE_REFRESH_SWEEP_INTERVAL_MS = 60 * 1000;
const usageRefreshBuckets = new Map();
const usageRefreshBucketStates = new WeakMap();

function normalizeText(value, fallback = '') {
  return String(value || fallback).trim();
}

function positiveInteger(value, fallback, minimum = 1, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum) return fallback;
  return Math.min(maximum, Math.floor(parsed));
}

function getClientKey(req) {
  // This service has no trusted-proxy configuration. A client-controlled
  // X-Forwarded-For header must therefore never define a rate-limit bucket.
  return req.socket?.remoteAddress || 'unknown';
}

function stateForBuckets(buckets) {
  let state = usageRefreshBucketStates.get(buckets);
  if (!state) {
    state = { lastSweepAt: 0 };
    usageRefreshBucketStates.set(buckets, state);
  }
  return state;
}

function sweepUsageRefreshBuckets(buckets = usageRefreshBuckets, now = Date.now(), maxBuckets = MAX_USAGE_REFRESH_BUCKETS) {
  let removed = 0;
  for (const [key, bucket] of buckets) {
    if (!bucket || now >= Number(bucket.resetAt || 0)) {
      buckets.delete(key);
      removed += 1;
    }
  }
  const boundedMaxBuckets = positiveInteger(maxBuckets, MAX_USAGE_REFRESH_BUCKETS);
  while (buckets.size > boundedMaxBuckets) {
    let oldestKey = null;
    let oldestResetAt = Infinity;
    for (const [key, bucket] of buckets) {
      const resetAt = Number(bucket?.resetAt) || 0;
      if (resetAt < oldestResetAt) {
        oldestResetAt = resetAt;
        oldestKey = key;
      }
    }
    if (oldestKey === null) break;
    buckets.delete(oldestKey);
    removed += 1;
  }
  return removed;
}

function evictOldestUsageBucket(buckets) {
  let oldestKey = null;
  let oldestResetAt = Infinity;
  for (const [key, bucket] of buckets) {
    const resetAt = Number(bucket?.resetAt) || 0;
    if (resetAt < oldestResetAt) {
      oldestResetAt = resetAt;
      oldestKey = key;
    }
  }
  if (oldestKey === null) return false;
  return buckets.delete(oldestKey);
}

function checkUsageRefreshLimit(req, name, options = {}) {
  const buckets = options.buckets || usageRefreshBuckets;
  const limit = positiveInteger(options.limit, USAGE_REFRESH_LIMIT);
  const windowMs = positiveInteger(options.windowMs, USAGE_REFRESH_WINDOW_MS);
  const maxBuckets = positiveInteger(options.maxBuckets || process.env.MAX_USAGE_REFRESH_BUCKETS, MAX_USAGE_REFRESH_BUCKETS);
  const sweepIntervalMs = positiveInteger(options.sweepIntervalMs || process.env.USAGE_REFRESH_SWEEP_INTERVAL_MS, USAGE_REFRESH_SWEEP_INTERVAL_MS);
  const now = typeof options.now === 'number' ? options.now : Date.now();
  const state = stateForBuckets(buckets);
  if (now - state.lastSweepAt >= sweepIntervalMs || buckets.size >= maxBuckets) {
    sweepUsageRefreshBuckets(buckets, now, maxBuckets);
    state.lastSweepAt = now;
  }

  const key = `${name}:${getClientKey(req)}`;
  let bucket = buckets.get(key);
  if (bucket && now >= bucket.resetAt) {
    buckets.delete(key);
    bucket = null;
  }
  if (!bucket) {
    while (buckets.size >= maxBuckets && evictOldestUsageBucket(buckets)) {}
    bucket = { count: 0, resetAt: now + windowMs };
    buckets.set(key, bucket);
  }
  if (bucket.count >= limit) {
    return { allowed: false, resetMs: Math.max(0, bucket.resetAt - now) };
  }
  bucket.count += 1;
  return { allowed: true, remaining: Math.max(0, limit - bucket.count), resetMs: Math.max(0, bucket.resetAt - now) };
}
function usageRateLimitHeaders(result = {}) {
  return {
    'Access-Control-Allow-Origin': '*',
    'X-RateLimit-Limit': String(USAGE_REFRESH_LIMIT),
    'X-RateLimit-Remaining': String(result.remaining || 0),
    'Retry-After': String(Math.max(1, Math.ceil(Number(result.resetMs || 0) / 1000))),
  };
}

function rangeFromUrl(req) {
  const url = new URL(req.url || '/', 'http://localhost');
  const range = normalizeText(url.searchParams.get('range'), 'today');
  return isPersonalRange(range) ? range : null;
}

function normalizePersonalRange(value) {
  const range = normalizeText(value, 'today');
  return isPersonalRange(range) ? range : null;
}

function normalizeDepartmentRange(value) {
  const range = normalizeText(value, 'today');
  return isDepartmentRange(range) ? range : null;
}

function normalizeApiKey(body) {
  return normalizeText(body?.api_key || body?.apiKey);
}

function normalizeDepartmentId(body) {
  return normalizeText(body?.department_id || body?.departmentId);
}

function departmentPassword() {
  return normalizeText(process.env.USAGE_DEPARTMENT_PASSWORD || process.env.USAGE_STATS_DEPARTMENT_PASSWORD);
}

function constantTimeEquals(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function isDepartmentPasswordValid(password) {
  const expected = departmentPassword();
  return Boolean(expected) && constantTimeEquals(password, expected);
}

function normalizeDepartmentPassword(body) {
  return normalizeText(body?.password || body?.departmentPassword);
}

function hasDepartmentPassword() {
  return Boolean(departmentPassword());
}

function resetUsageRefreshBuckets() {
  usageRefreshBuckets.clear();
  usageRefreshBucketStates.delete(usageRefreshBuckets);
}

module.exports = {
  USAGE_REFRESH_LIMIT,
  USAGE_REFRESH_WINDOW_MS,
  MAX_USAGE_REFRESH_BUCKETS,
  USAGE_REFRESH_SWEEP_INTERVAL_MS,
  checkUsageRefreshLimit,
  constantTimeEquals,
  departmentPassword,
  getClientKey,
  hasDepartmentPassword,
  isDepartmentPasswordValid,
  normalizeApiKey,
  normalizeDepartmentId,
  normalizeDepartmentPassword,
  normalizeDepartmentRange,
  normalizePersonalRange,
  rangeFromUrl,
  resetUsageRefreshBuckets,
  sweepUsageRefreshBuckets,
  usageRateLimitHeaders,
};
