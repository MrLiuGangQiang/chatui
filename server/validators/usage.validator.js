const crypto = require('crypto');
const { isDepartmentRange, isPersonalRange } = require('../usage/ranges');
const { positiveInteger } = require('../config/numbers');

const USAGE_REFRESH_LIMIT = 12;
const USAGE_REFRESH_WINDOW_MS = 60 * 1000;
const usageRefreshBuckets = new Map();
const MAX_USAGE_REFRESH_BUCKETS = positiveInteger(process.env.MAX_USAGE_REFRESH_BUCKETS, 4096, { max: 1_000_000 });

function normalizeText(value, fallback = '') {
  return String(value || fallback).trim();
}

function getClientKey(req) {
  // This service has no trusted-proxy configuration. A client-controlled
  // X-Forwarded-For header must therefore never define a rate-limit bucket.
  return req.socket?.remoteAddress || 'unknown';
}

function checkUsageRefreshLimit(req, name, options = {}) {
  const buckets = options.buckets || usageRefreshBuckets;
  const limit = positiveInteger(options.limit, USAGE_REFRESH_LIMIT, { max: 1_000_000 });
  const windowMs = positiveInteger(options.windowMs, USAGE_REFRESH_WINDOW_MS);
  const maxBuckets = positiveInteger(options.maxBuckets, MAX_USAGE_REFRESH_BUCKETS, { max: 1_000_000 });
  const now = typeof options.now === 'number' ? options.now : Date.now();
  const key = `${name}:${getClientKey(req)}`;
  let bucket = buckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    if (bucket) buckets.delete(key);
    if (buckets.size >= maxBuckets) {
      for (const [bucketKey, value] of buckets) {
        if (!value || now >= Number(value.resetAt || 0)) buckets.delete(bucketKey);
      }
    }
    while (buckets.size >= maxBuckets) {
      let oldestKey = null;
      let oldestReset = Infinity;
      for (const [bucketKey, value] of buckets) {
        const resetAt = Number(value?.resetAt || 0);
        if (resetAt < oldestReset) { oldestReset = resetAt; oldestKey = bucketKey; }
      }
      if (!oldestKey) break;
      buckets.delete(oldestKey);
    }
    bucket = { count: 0, resetAt: now + windowMs };
    buckets.set(key, bucket);
  }
  if (bucket.count >= limit) {
    return { allowed: false, limit, remaining: 0, resetMs: Math.max(0, bucket.resetAt - now) };
  }
  bucket.count += 1;
  return { allowed: true, limit, remaining: Math.max(0, limit - bucket.count), resetMs: Math.max(0, bucket.resetAt - now) };
}

function usageRateLimitHeaders(result = {}) {
  return {
    'Access-Control-Allow-Origin': '*',
    'X-RateLimit-Limit': String(result.limit || USAGE_REFRESH_LIMIT),
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
  const left = crypto.createHash('sha256').update(String(a || '')).digest();
  const right = crypto.createHash('sha256').update(String(b || '')).digest();
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
}

module.exports = {
  USAGE_REFRESH_LIMIT,
  USAGE_REFRESH_WINDOW_MS,
  MAX_USAGE_REFRESH_BUCKETS,
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
  usageRateLimitHeaders,
};
