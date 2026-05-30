const { readBody, parseJson } = require('../../http/body');

const RANGES = new Set(['today', 'yesterday', 'total']);
const USAGE_REFRESH_LIMIT = 6;
const USAGE_REFRESH_WINDOW_MS = 60 * 1000;
const usageRefreshBuckets = new Map();

function getClientKey(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket?.remoteAddress || 'unknown';
}

function checkUsageRefreshLimit(req, name) {
  const key = `${name}:${getClientKey(req)}`;
  const now = Date.now();
  let bucket = usageRefreshBuckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + USAGE_REFRESH_WINDOW_MS };
    usageRefreshBuckets.set(key, bucket);
  }
  if (bucket.count >= USAGE_REFRESH_LIMIT) {
    return { allowed: false, resetMs: Math.max(0, bucket.resetAt - now) };
  }
  bucket.count += 1;
  return { allowed: true, remaining: Math.max(0, USAGE_REFRESH_LIMIT - bucket.count), resetMs: Math.max(0, bucket.resetAt - now) };
}

function usageRateLimitHeaders(result = {}) {
  return {
    'Access-Control-Allow-Origin': '*',
    'X-RateLimit-Limit': String(USAGE_REFRESH_LIMIT),
    'X-RateLimit-Remaining': String(result.remaining || 0),
    'Retry-After': String(Math.max(1, Math.ceil(Number(result.resetMs || 0) / 1000))),
  };
}

function unavailablePayload() {
  return {
    available: false,
    reason: 'PostgreSQL 未配置，使用统计功能未启用',
    ranking: [],
    personal: null,
  };
}

function rangeFromUrl(req) {
  const url = new URL(req.url || '/', 'http://localhost');
  const range = String(url.searchParams.get('range') || 'today').trim();
  return RANGES.has(range) ? range : null;
}

function createUsageRoutes({ sendJson, sendMethodNotAllowed, usageStats }) {
  async function routeRankings(req, res) {
    if (req.method !== 'GET') return sendMethodNotAllowed(res);
    const limitResult = checkUsageRefreshLimit(req, 'rankings');
    if (!limitResult.allowed) {
      return sendJson(res, 200, {
        available: true,
        limited: true,
        message: '请不要频繁刷新，请一分钟后重试',
        ranking: [],
      }, usageRateLimitHeaders(limitResult));
    }
    if (!usageStats) return sendJson(res, 200, unavailablePayload(), { 'Access-Control-Allow-Origin': '*' });
    const range = rangeFromUrl(req);
    if (!range) return sendJson(res, 400, { error: { message: '不支持的排行范围' } }, { 'Access-Control-Allow-Origin': '*' });
    try {
      const ranking = await usageStats.getRanking(range);
      return sendJson(res, 200, { available: true, range, ranking }, { 'Access-Control-Allow-Origin': '*' });
    } catch (err) {
      console.error('[usage] rankings query failed:', err);
      return sendJson(res, 500, { error: { message: '查询使用排行榜失败' } }, { 'Access-Control-Allow-Origin': '*' });
    }
  }

  async function routePersonal(req, res) {
    if (req.method !== 'POST') return sendMethodNotAllowed(res);
    let body;
    try {
      body = parseJson(await readBody(req));
    } catch (err) {
      return sendJson(res, 400, { error: { message: err.message || '请求体不是有效 JSON' } }, { 'Access-Control-Allow-Origin': '*' });
    }
    const apiKey = String(body?.api_key || body?.apiKey || '').trim();
    if (!apiKey) return sendJson(res, 400, { error: { message: '缺少 api_key' } }, { 'Access-Control-Allow-Origin': '*' });
    const range = String(body?.range || 'today').trim();
    if (!RANGES.has(range)) return sendJson(res, 400, { error: { message: '不支持的统计范围' } }, { 'Access-Control-Allow-Origin': '*' });
    const limitResult = checkUsageRefreshLimit(req, 'personal');
    if (!limitResult.allowed) {
      return sendJson(res, 200, {
        available: true,
        limited: true,
        message: '请不要频繁刷新，请一分钟后重试',
        personal: null,
      }, usageRateLimitHeaders(limitResult));
    }
    if (!usageStats) return sendJson(res, 200, unavailablePayload(), { 'Access-Control-Allow-Origin': '*' });
    try {
      const personal = await usageStats.getPersonalRange(apiKey, range);
      return sendJson(res, 200, { available: true, range, personal }, { 'Access-Control-Allow-Origin': '*' });
    } catch (err) {
      console.error('[usage] personal query failed:', err);
      return sendJson(res, 500, { error: { message: '查询个人使用统计失败' } }, { 'Access-Control-Allow-Origin': '*' });
    }
  }

  function routeUsage(req, res) {
    const pathname = String(req.url || '').split('?')[0];
    if (pathname === '/api/usage/rankings') return routeRankings(req, res);
    if (pathname === '/api/usage/personal') return routePersonal(req, res);
    return sendJson(res, 404, { error: { message: '未找到使用统计接口' } }, { 'Access-Control-Allow-Origin': '*' });
  }

  return { routeUsage };
}

module.exports = { createUsageRoutes };
