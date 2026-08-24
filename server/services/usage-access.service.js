'use strict';

const crypto = require('crypto');
const { DEFAULT_UPSTREAM_BASE_URL } = require('../config');

const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 512;
const MAX_IN_FLIGHT = 64;
const REQUEST_TIMEOUT_MS = 10 * 1000;

function positiveInteger(value, fallback, minimum = 1, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum) return fallback;
  return Math.min(maximum, Math.floor(parsed));
}

function normalizeBaseUrl(value = DEFAULT_UPSTREAM_BASE_URL) {
  return String(value || DEFAULT_UPSTREAM_BASE_URL).trim().replace(/\/+$/, '');
}

function cacheKey(baseUrl, apiKey, model) {
  return crypto.createHash('sha256').update(`${normalizeBaseUrl(baseUrl)}\n${apiKey}\n${model}`).digest('hex');
}

function modelsFromPayload(payload) {
  const list = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [];
  return new Set(list.map(item => String(typeof item === 'string' ? item : item?.id || item?.name || '').trim()).filter(Boolean));
}

function createUsageAccessValidator({
  fetchImpl = global.fetch,
  now = () => Date.now(),
  baseUrl = DEFAULT_UPSTREAM_BASE_URL,
  cacheTtlMs = positiveInteger(process.env.USAGE_ACCESS_CACHE_TTL_MS, CACHE_TTL_MS),
  maxEntries = positiveInteger(process.env.USAGE_ACCESS_CACHE_MAX_ENTRIES, MAX_CACHE_ENTRIES),
  maxInFlight = positiveInteger(process.env.USAGE_ACCESS_MAX_IN_FLIGHT, MAX_IN_FLIGHT),
  requestTimeoutMs = positiveInteger(process.env.USAGE_ACCESS_TIMEOUT_MS, REQUEST_TIMEOUT_MS),
} = {}) {
  const cache = new Map();
  const inFlight = new Map();
  const boundedTtlMs = positiveInteger(cacheTtlMs, CACHE_TTL_MS);
  const boundedMaxEntries = positiveInteger(maxEntries, MAX_CACHE_ENTRIES);
  const boundedMaxInFlight = positiveInteger(maxInFlight, MAX_IN_FLIGHT);
  const boundedTimeoutMs = positiveInteger(requestTimeoutMs, REQUEST_TIMEOUT_MS);
  const defaultBaseUrl = normalizeBaseUrl(baseUrl);

  function sweepExpired(time = now()) {
    for (const [key, entry] of cache) {
      if (!entry || entry.expiresAt <= time) cache.delete(key);
    }
    return cache.size;
  }

  function trimCache() {
    while (cache.size > boundedMaxEntries) cache.delete(cache.keys().next().value);
  }

  function readCache(key, time) {
    const cached = cache.get(key);
    if (!cached) return null;
    if (cached.expiresAt <= time) {
      cache.delete(key);
      return null;
    }
    // Map insertion order is the LRU order. Refreshing the entry on a hit keeps
    // frequently used API-key/model pairs while still enforcing a hard bound.
    cache.delete(key);
    cache.set(key, cached);
    return cached.result;
  }

  function writeCache(key, result, time) {
    sweepExpired(time);
    cache.delete(key);
    cache.set(key, { result, expiresAt: time + boundedTtlMs });
    trimCache();
  }

  async function validateUpstream(normalizedKey, normalizedModel, resolvedBaseUrl, key) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), boundedTimeoutMs);
    try {
      const response = await fetchImpl(`${resolvedBaseUrl}/models`, {
        headers: { Authorization: `Bearer ${normalizedKey}` },
        signal: controller.signal,
      });
      if (!response.ok) return { ok: false, statusCode: 403, code: 'INVALID_API_KEY', message: 'API Key 无效，统计和反馈暂不可用' };
      const models = modelsFromPayload(await response.json());
      const result = models.has(normalizedModel)
        ? { ok: true }
        : { ok: false, statusCode: 400, code: 'MODEL_NOT_CONFIGURED', message: '当前聊天模型未正确配置，统计和反馈暂不可用' };
      writeCache(key, result, now());
      return result;
    } catch {
      return { ok: false, statusCode: 503, code: 'MODEL_VALIDATION_UNAVAILABLE', message: '无法验证 API Key 和模型配置，统计和反馈暂不可用' };
    } finally {
      clearTimeout(timer);
    }
  }

  async function validate(apiKey, model, options = {}) {
    const normalizedKey = String(apiKey || '').trim();
    const normalizedModel = String(model || '').trim();
    if (!normalizedKey) return { ok: false, statusCode: 400, code: 'INVALID_API_KEY', message: '请先配置有效的 API Key' };
    if (!normalizedModel) return { ok: false, statusCode: 400, code: 'MODEL_NOT_CONFIGURED', message: '请先正确配置聊天模型' };
    const resolvedBaseUrl = normalizeBaseUrl(options.baseUrl || defaultBaseUrl);
    const key = cacheKey(resolvedBaseUrl, normalizedKey, normalizedModel);
    const time = now();
    const cached = readCache(key, time);
    if (cached) return cached;
    const pending = inFlight.get(key);
    if (pending) return pending;
    if (inFlight.size >= boundedMaxInFlight) {
      return { ok: false, statusCode: 503, code: 'MODEL_VALIDATION_BUSY', message: '验证请求过多，请稍后重试统计或反馈' };
    }

    let tracked;
    tracked = validateUpstream(normalizedKey, normalizedModel, resolvedBaseUrl, key)
      .finally(() => {
        if (inFlight.get(key) === tracked) inFlight.delete(key);
      });
    inFlight.set(key, tracked);
    return tracked;
  }

  function stats() {
    sweepExpired(now());
    return Object.freeze({ cache_entries: cache.size, in_flight: inFlight.size });
  }

  function clear() {
    cache.clear();
  }

  return Object.freeze({ validate, stats, clear, sweep: sweepExpired });
}

module.exports = {
  CACHE_TTL_MS,
  MAX_CACHE_ENTRIES,
  MAX_IN_FLIGHT,
  REQUEST_TIMEOUT_MS,
  cacheKey,
  createUsageAccessValidator,
  modelsFromPayload,
};