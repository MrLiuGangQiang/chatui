const { readBody, parseJson } = require('../../http/body');

const RANGES = new Set(['today', 'yesterday', 'total']);

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
    if (!usageStats) return sendJson(res, 200, unavailablePayload(), { 'Access-Control-Allow-Origin': '*' });
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
