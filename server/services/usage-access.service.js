const crypto = require('crypto');
const { DEFAULT_UPSTREAM_BASE_URL } = require('../config');
const { fetchWithValidatedRedirects, readUpstreamTextWithLimit, safeParseJson } = require('../jobs/common');
const { normalizeBaseUrl } = require('../security/url-policy');

const CACHE_TTL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10 * 1000;
const MAX_CACHE_ENTRIES = 256;
const MAX_API_KEY_LENGTH = 4096;
const MAX_MODEL_LENGTH = 256;
const MAX_MODELS_RESPONSE_BYTES = 2 * 1024 * 1024;

function cacheKey(apiKey, model, baseUrl) {
  return crypto.createHash('sha256').update(`${apiKey}\n${model}\n${baseUrl}`).digest('hex');
}

function modelsFromPayload(payload) {
  const list = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [];
  return new Set(list.map(item => String(typeof item === 'string' ? item : item?.id || item?.name || '').trim()).filter(Boolean));
}

function validateUsageBaseUrl(baseUrl, trustedBaseUrl = DEFAULT_UPSTREAM_BASE_URL) {
  const trusted = normalizeBaseUrl(trustedBaseUrl);
  if (!trusted) {
    return { ok: false, statusCode: 503, code: 'MODEL_VALIDATION_UNAVAILABLE', message: '模型验证服务地址无效' };
  }
  if (!String(baseUrl || '').trim()) {
    return { ok: false, statusCode: 400, code: 'UPSTREAM_BASE_URL_REQUIRED', message: '缺少当前 API 服务地址，无法安全验证统计权限' };
  }
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) {
    return { ok: false, statusCode: 400, code: 'INVALID_UPSTREAM_BASE_URL', message: '当前 API 服务地址无效' };
  }
  if (normalized !== trusted) {
    return { ok: false, statusCode: 403, code: 'UPSTREAM_BASE_URL_MISMATCH', message: '当前 API 服务不支持使用统计和反馈' };
  }
  return { ok: true, baseUrl: normalized };
}

function createUsageAccessValidator({ fetchImpl = global.fetch, now = () => Date.now(), trustedBaseUrl = DEFAULT_UPSTREAM_BASE_URL } = {}) {
  const cache = new Map();
  const inFlight = new Map();

  async function validate(apiKey, model, { baseUrl } = {}) {
    const normalizedKey = String(apiKey || '').trim();
    const normalizedModel = String(model || '').trim();
    if (!normalizedKey) return { ok: false, statusCode: 400, code: 'INVALID_API_KEY', message: '请先配置有效的 API Key' };
    if (!normalizedModel) return { ok: false, statusCode: 400, code: 'MODEL_NOT_CONFIGURED', message: '请先正确配置聊天模型' };
    if (normalizedKey.length > MAX_API_KEY_LENGTH || /[\r\n\u0000]/.test(normalizedKey)) return { ok: false, statusCode: 400, code: 'INVALID_API_KEY', message: 'API Key 格式无效' };
    if (normalizedModel.length > MAX_MODEL_LENGTH || /[\r\n\u0000]/.test(normalizedModel)) return { ok: false, statusCode: 400, code: 'MODEL_NOT_CONFIGURED', message: '聊天模型名称格式无效' };
    const baseUrlValidation = validateUsageBaseUrl(baseUrl, trustedBaseUrl);
    if (!baseUrlValidation.ok) return baseUrlValidation;
    const normalizedBaseUrl = baseUrlValidation.baseUrl;
    const key = cacheKey(normalizedKey, normalizedModel, normalizedBaseUrl);
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now()) return cached.result;

    const pending = inFlight.get(key);
    if (pending) return pending;
    const request = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        // The caller-selected endpoint was checked above and is part of the
        // cache key. Never send credentials to a server-side fallback here.
        const response = await fetchWithValidatedRedirects(`${normalizedBaseUrl}/models`, {
          headers: { Authorization: `Bearer ${normalizedKey}` },
          signal: controller.signal,
        }, { fetchImpl });
        const text = await readUpstreamTextWithLimit(response, MAX_MODELS_RESPONSE_BYTES);
        if (!response.ok) return { ok: false, statusCode: 403, code: 'INVALID_API_KEY', message: 'API Key 无效，统计和反馈暂不可用' };
        const models = modelsFromPayload(safeParseJson(text));
        const result = models.has(normalizedModel)
          ? { ok: true }
          : { ok: false, statusCode: 400, code: 'MODEL_NOT_CONFIGURED', message: '当前聊天模型未正确配置，统计和反馈暂不可用' };
        cache.set(key, { result, expiresAt: now() + CACHE_TTL_MS });
        while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
        return result;
      } catch {
        return { ok: false, statusCode: 503, code: 'MODEL_VALIDATION_UNAVAILABLE', message: '无法验证 API Key 和模型配置，统计和反馈暂不可用' };
      } finally {
        clearTimeout(timer);
      }
    })();
    inFlight.set(key, request);
    try { return await request; }
    finally { if (inFlight.get(key) === request) inFlight.delete(key); }
  }

  return { validate };
}

module.exports = { createUsageAccessValidator, modelsFromPayload, validateUsageBaseUrl, MAX_MODELS_RESPONSE_BYTES };
