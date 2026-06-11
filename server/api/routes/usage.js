const { readBody, parseJson } = require('../../http/body');
const { SECURITY_HEADERS } = require('../../http/response');

const RANGES = new Set(['today', 'yesterday', 'total']);
const RANKING_TYPES = new Set(['user', 'project']);
const EXPORT_ALLOWED_USERS = new Set(['许龙', '金晶', '黄杰', '莫振海', '刘岗强']);

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

function rankingTypeFromUrl(req) {
  const url = new URL(req.url || '/', 'http://localhost');
  const type = String(url.searchParams.get('type') || 'user').trim();
  return RANKING_TYPES.has(type) ? type : null;
}

function projectIdFromUrl(req) {
  const url = new URL(req.url || '/', 'http://localhost');
  const value = String(url.searchParams.get('project_id') || url.searchParams.get('projectId') || '').trim();
  if (!value) return null;
  const id = Number(value);
  return Number.isFinite(id) ? Math.floor(id) : null;
}

function projectIdFromBody(body) {
  const value = body?.project_id ?? body?.projectId ?? null;
  if (value === null || value === undefined || value === '') return null;
  const id = Number(value);
  return Number.isFinite(id) ? Math.floor(id) : null;
}

function escapeXml(value) {
  return String(value ?? '').replace(/[<>&"']/g, ch => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[ch]));
}

function rangeLabel(range) {
  return range === 'today' ? '今日' : range === 'yesterday' ? '昨日' : '总计';
}

function rankingTypeLabel(type) {
  return type === 'project' ? '项目排行' : '个人排行';
}

function rankingName(row = {}, type = 'user') {
  return type === 'project' ? row.project_name || '未分配项目' : row.username || '-';
}

function excelCell(value, type = 'String') {
  const data = type === 'Number' ? Number(value) || 0 : escapeXml(value);
  return `<Cell><Data ss:Type="${type}">${data}</Data></Cell>`;
}

function percentText(value) {
  const number = Number(value) || 0;
  return `${number.toFixed(2).replace(/\.0+$/, '').replace(/(\.\d)0$/, '$1')}%`;
}

function buildRankingExcel(rows = [], { range = 'today', type = 'user' } = {}) {
  const headers = type === 'project'
    ? ['排名', '项目', '占比', '总用量', '输入', '输出', '缓存输入', '推理输出']
    : ['排名', '用户', '总用量', '输入', '输出', '缓存输入', '推理输出'];
  const bodyRows = rows.map((row, index) => [
    index + 1,
    rankingName(row, type),
    ...(type === 'project' ? [percentText(row.total_percent)] : []),
    row.total_tokens,
    row.prompt_tokens,
    row.completion_tokens,
    row.prompt_cached_tokens,
    row.completion_reasoning_tokens,
  ]);
  const worksheetName = `${rangeLabel(range)}${rankingTypeLabel(type)}`;
  const rowsXml = [headers, ...bodyRows].map((row, rowIndex) => `<Row>${row.map((value, index) => excelCell(value, rowIndex > 0 && index !== 1 && !(type === 'project' && index === 2) ? 'Number' : 'String')).join('')}</Row>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
  <Worksheet ss:Name="${escapeXml(worksheetName)}">
    <Table>${rowsXml}</Table>
  </Worksheet>
</Workbook>`;
}

function contentDispositionFilename(filename) {
  return `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function isUsageExportAllowedUser(username) {
  return EXPORT_ALLOWED_USERS.has(String(username || '').trim());
}

function createUsageRoutes({ sendJson, sendMethodNotAllowed, usageStats }) {
  async function routeRankings(req, res) {
    if (req.method !== 'GET') return sendMethodNotAllowed(res);
    if (!usageStats) return sendJson(res, 200, unavailablePayload(), { 'Access-Control-Allow-Origin': '*' });
    const range = rangeFromUrl(req);
    if (!range) return sendJson(res, 400, { error: { message: '不支持的排行范围' } }, { 'Access-Control-Allow-Origin': '*' });
    const type = rankingTypeFromUrl(req);
    if (!type) return sendJson(res, 400, { error: { message: '不支持的排行类型' } }, { 'Access-Control-Allow-Origin': '*' });
    try {
      const projectId = type === 'user' ? projectIdFromUrl(req) : null;
      const ranking = await usageStats.getRanking(range, type, { projectId });
      return sendJson(res, 200, { available: true, range, type, project_id: projectId, ranking }, { 'Access-Control-Allow-Origin': '*' });
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
    if (!usageStats) return sendJson(res, 200, unavailablePayload(), { 'Access-Control-Allow-Origin': '*' });
    try {
      const personal = await usageStats.getPersonalRange(apiKey, range);
      return sendJson(res, 200, { available: true, range, personal }, { 'Access-Control-Allow-Origin': '*' });
    } catch (err) {
      console.error('[usage] personal query failed:', err);
      return sendJson(res, 500, { error: { message: '查询个人使用统计失败' } }, { 'Access-Control-Allow-Origin': '*' });
    }
  }

  async function routeRankingExport(req, res) {
    if (req.method !== 'POST') return sendMethodNotAllowed(res);
    let body;
    try {
      body = parseJson(await readBody(req));
    } catch (err) {
      return sendJson(res, 400, { error: { message: err.message || '请求体不是有效 JSON' } }, { 'Access-Control-Allow-Origin': '*' });
    }
    if (!usageStats) return sendJson(res, 200, unavailablePayload(), { 'Access-Control-Allow-Origin': '*' });
    const apiKey = String(body?.api_key || body?.apiKey || '').trim();
    if (!apiKey) return sendJson(res, 400, { error: { message: '缺少 api_key' } }, { 'Access-Control-Allow-Origin': '*' });
    const range = String(body?.range || 'today').trim();
    if (!RANGES.has(range)) return sendJson(res, 400, { error: { message: '不支持的排行范围' } }, { 'Access-Control-Allow-Origin': '*' });
    const type = String(body?.type || 'user').trim();
    if (!RANKING_TYPES.has(type)) return sendJson(res, 400, { error: { message: '不支持的排行类型' } }, { 'Access-Control-Allow-Origin': '*' });
    try {
      const owner = await usageStats.getApiKeyOwner(apiKey);
      if (!isUsageExportAllowedUser(owner)) {
        return sendJson(res, 403, { error: { message: '当前 API Key 无权导出排行榜' } }, { 'Access-Control-Allow-Origin': '*' });
      }
      const projectId = type === 'user' ? projectIdFromBody(body) : null;
      const ranking = await usageStats.getRanking(range, type, { projectId });
      const excel = buildRankingExcel(ranking, { range, type });
      const filename = `usage-${type}-${range}.xls`;
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': 'application/vnd.ms-excel; charset=utf-8',
        'Content-Disposition': contentDispositionFilename(filename),
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      });
      return res.end(excel);
    } catch (err) {
      console.error('[usage] ranking export failed:', err);
      return sendJson(res, 500, { error: { message: '导出排行榜失败' } }, { 'Access-Control-Allow-Origin': '*' });
    }
  }

  function routeUsage(req, res) {
    const pathname = String(req.url || '').split('?')[0];
    if (pathname === '/api/usage/rankings') return routeRankings(req, res);
    if (pathname === '/api/usage/rankings/export') return routeRankingExport(req, res);
    if (pathname === '/api/usage/personal') return routePersonal(req, res);
    return sendJson(res, 404, { error: { message: '未找到使用统计接口' } }, { 'Access-Control-Allow-Origin': '*' });
  }

  return { routeUsage };
}

module.exports = { createUsageRoutes, buildRankingExcel, isUsageExportAllowedUser };
