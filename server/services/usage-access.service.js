const crypto = require('crypto');
const { DEFAULT_UPSTREAM_BASE_URL } = require('../config');

const CACHE_TTL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10 * 1000;

function cacheKey(apiKey, model) {
  return crypto.createHash('sha256').update(`${apiKey}\n${model}`).digest('hex');
}

function modelsFromPayload(payload) {
  const list = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [];
  return new Set(list.map(item => String(typeof item === 'string' ? item : item?.id || item?.name || '').trim()).filter(Boolean));
}

function createUsageAccessValidator({ fetchImpl = global.fetch, now = () => Date.now() } = {}) {
  const cache = new Map();

  async function validate(apiKey, model) {
    const normalizedKey = String(apiKey || '').trim();
    const normalizedModel = String(model || '').trim();
    if (!normalizedKey) return { ok: false, statusCode: 400, code: 'INVALID_API_KEY', message: '请先配置有效的 API Key' };
    if (!normalizedModel) return { ok: false, statusCode: 400, code: 'MODEL_NOT_CONFIGURED', message: '请先正确配置聊天模型' };
    const key = cacheKey(normalizedKey, normalizedModel);
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now()) return cached.result;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetchImpl(`${DEFAULT_UPSTREAM_BASE_URL}/models`, {
        headers: { Authorization: `Bearer ${normalizedKey}` },
        signal: controller.signal,
      });
      if (!response.ok) return { ok: false, statusCode: 403, code: 'INVALID_API_KEY', message: 'API Key 无效，统计和反馈暂不可用' };
      const models = modelsFromPayload(await response.json());
      const result = models.has(normalizedModel)
        ? { ok: true }
        : { ok: false, statusCode: 400, code: 'MODEL_NOT_CONFIGURED', message: '当前聊天模型未正确配置，统计和反馈暂不可用' };
      cache.set(key, { result, expiresAt: now() + CACHE_TTL_MS });
      return result;
    } catch {
      return { ok: false, statusCode: 503, code: 'MODEL_VALIDATION_UNAVAILABLE', message: '无法验证 API Key 和模型配置，统计和反馈暂不可用' };
    } finally {
      clearTimeout(timer);
    }
  }

  return { validate };
}

module.exports = { createUsageAccessValidator, modelsFromPayload };
