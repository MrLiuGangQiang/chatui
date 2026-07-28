const crypto = require('crypto');
const { isDepartmentRange, isPersonalRange } = require('../usage/ranges');

const USAGE_REFRESH_LIMIT = 12;
const USAGE_REFRESH_WINDOW_MS = 60 * 1000;
const usageRefreshBuckets = new Map();

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
  const limit = Number(options.limit || USAGE_REFRESH_LIMIT);
  const windowMs = Number(options.windowMs || USAGE_REFRESH_WINDOW_MS);
  const now = typeof options.now === 'number' ? options.now : Date.now();
  const key = `${name}:${getClientKey(req)}`;
  let bucket = buckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
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
}

module.exports = {
  USAGE_REFRESH_LIMIT,
  USAGE_REFRESH_WINDOW_MS,
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
