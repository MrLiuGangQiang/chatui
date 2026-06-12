const { readBody, parseJson } = require('../../http/body');

const RANGES = new Set(['today', 'yesterday', 'total']);
const DEPARTMENT_RANGES = new Set(['today', 'yesterday', 'month', 'last_month', 'total']);
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

function departmentUnavailablePayload(reason = '部门统计密码未配置，部门统计功能未启用') {
  return {
    available: false,
    reason,
    ranking: [],
  };
}

function rangeFromUrl(req) {
  const url = new URL(req.url || '/', 'http://localhost');
  const range = String(url.searchParams.get('range') || 'today').trim();
  return RANGES.has(range) ? range : null;
}

function departmentPassword() {
  return String(process.env.USAGE_DEPARTMENT_PASSWORD || process.env.USAGE_STATS_DEPARTMENT_PASSWORD || '').trim();
}

function constantTimeEquals(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  if (left.length !== right.length) return false;
  return require('crypto').timingSafeEqual(left, right);
}

function isDepartmentPasswordValid(password) {
  const expected = departmentPassword();
  return Boolean(expected) && constantTimeEquals(password, expected);
}

async function readJsonBody(req, res, sendJson) {
  try {
    return parseJson(await readBody(req));
  } catch (err) {
    sendJson(res, 400, { error: { message: err.message || '请求体不是有效 JSON' } }, { 'Access-Control-Allow-Origin': '*' });
    return null;
  }
}

function validateDepartmentAccess(body, res, sendJson) {
  if (!departmentPassword()) {
    sendJson(res, 200, departmentUnavailablePayload(), { 'Access-Control-Allow-Origin': '*' });
    return false;
  }
  const password = String(body?.password || body?.departmentPassword || '').trim();
  if (!isDepartmentPasswordValid(password)) {
    sendJson(res, 403, { available: true, authorized: false, error: { message: '密码错误，无权限访问' } }, { 'Access-Control-Allow-Origin': '*' });
    return false;
  }
  return true;
}

function safeXml(value) {
  return String(value ?? '').replace(/[<>&"']/g, ch => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[ch]));
}

function safeSheetName(value) {
  const cleaned = String(value || '统计').replace(/[\\/?*\[\]:]/g, '').slice(0, 31);
  return cleaned || '统计';
}

function xlsCell(value, type = 'String') {
  const isNumber = type === 'Number';
  return `<Cell><Data ss:Type="${isNumber ? 'Number' : 'String'}">${safeXml(isNumber ? Number(value) || 0 : value)}</Data></Cell>`;
}

function xlsWorksheet(name, headers, rows) {
  const head = `<Row>${headers.map(item => xlsCell(item)).join('')}</Row>`;
  const body = rows.map(row => `<Row>${row.map(value => xlsCell(value, typeof value === 'number' ? 'Number' : 'String')).join('')}</Row>`).join('');
  return `<Worksheet ss:Name="${safeXml(safeSheetName(name))}"><Table>${head}${body}</Table></Worksheet>`;
}

function buildDepartmentExportWorkbook(rangeLabel, departments = [], usersByDepartment = {}) {
  const headers = ['部门主键', '部门名称', '总用量', '输入', '输出', '缓存输入', '推理输出'];
  const userHeaders = ['用户名称', '总用量', '输入', '输出', '缓存输入', '推理输出'];
  const departmentRows = departments.map(row => [row.department_id, row.department_name, row.total_tokens, row.prompt_tokens, row.completion_tokens, row.prompt_cached_tokens, row.completion_reasoning_tokens]);
  const sheets = [xlsWorksheet(`部门${rangeLabel}统计`, headers, departmentRows)];
  departments.forEach(row => {
    const userRows = (usersByDepartment[row.department_id] || []).map(user => [user.username, user.total_tokens, user.prompt_tokens, user.completion_tokens, user.prompt_cached_tokens, user.completion_reasoning_tokens]);
    sheets.push(xlsWorksheet(`${row.department_name || row.department_id}${rangeLabel}统计`, userHeaders, userRows));
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<?mso-application progid="Excel.Sheet"?>\n<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">${sheets.join('')}</Workbook>`;
}

function createUsageRoutes({ sendJson, sendMethodNotAllowed, usageStats, send }) {
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
    const body = await readJsonBody(req, res, sendJson);
    if (!body) return;
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

  async function routeDepartmentVerify(req, res) {
    if (req.method !== 'POST') return sendMethodNotAllowed(res);
    const body = await readJsonBody(req, res, sendJson);
    if (!body) return;
    if (!departmentPassword()) return sendJson(res, 200, departmentUnavailablePayload(), { 'Access-Control-Allow-Origin': '*' });
    if (!isDepartmentPasswordValid(String(body?.password || '').trim())) {
      return sendJson(res, 403, { available: true, authorized: false, error: { message: '密码错误，无权限访问' } }, { 'Access-Control-Allow-Origin': '*' });
    }
    return sendJson(res, 200, { available: true, authorized: true }, { 'Access-Control-Allow-Origin': '*' });
  }

  async function routeDepartmentRankings(req, res) {
    if (req.method !== 'POST') return sendMethodNotAllowed(res);
    const body = await readJsonBody(req, res, sendJson);
    if (!body) return;
    if (!validateDepartmentAccess(body, res, sendJson)) return;
    if (!usageStats) return sendJson(res, 200, departmentUnavailablePayload('PostgreSQL 未配置，部门统计功能未启用'), { 'Access-Control-Allow-Origin': '*' });
    const range = String(body?.range || 'today').trim();
    if (!DEPARTMENT_RANGES.has(range)) return sendJson(res, 400, { error: { message: '不支持的部门统计范围' } }, { 'Access-Control-Allow-Origin': '*' });
    try {
      const ranking = await usageStats.getDepartmentRanking(range);
      return sendJson(res, 200, { available: true, range, ranking }, { 'Access-Control-Allow-Origin': '*' });
    } catch (err) {
      console.error('[usage] department rankings query failed:', err);
      return sendJson(res, 500, { error: { message: '查询部门统计失败' } }, { 'Access-Control-Allow-Origin': '*' });
    }
  }

  async function routeDepartmentUsers(req, res) {
    if (req.method !== 'POST') return sendMethodNotAllowed(res);
    const body = await readJsonBody(req, res, sendJson);
    if (!body) return;
    if (!validateDepartmentAccess(body, res, sendJson)) return;
    if (!usageStats) return sendJson(res, 200, departmentUnavailablePayload('PostgreSQL 未配置，部门统计功能未启用'), { 'Access-Control-Allow-Origin': '*' });
    const range = String(body?.range || 'today').trim();
    const departmentId = String(body?.department_id || body?.departmentId || '').trim();
    if (!DEPARTMENT_RANGES.has(range)) return sendJson(res, 400, { error: { message: '不支持的部门统计范围' } }, { 'Access-Control-Allow-Origin': '*' });
    if (!departmentId) return sendJson(res, 400, { error: { message: '缺少部门主键' } }, { 'Access-Control-Allow-Origin': '*' });
    try {
      const users = await usageStats.getDepartmentUsers(departmentId, range);
      return sendJson(res, 200, { available: true, range, department_id: departmentId, users }, { 'Access-Control-Allow-Origin': '*' });
    } catch (err) {
      console.error('[usage] department users query failed:', err);
      return sendJson(res, 500, { error: { message: '查询部门用户统计失败' } }, { 'Access-Control-Allow-Origin': '*' });
    }
  }

  async function routeDepartmentExport(req, res) {
    if (req.method !== 'POST') return sendMethodNotAllowed(res);
    const body = await readJsonBody(req, res, sendJson);
    if (!body) return;
    if (!validateDepartmentAccess(body, res, sendJson)) return;
    if (!usageStats) return sendJson(res, 200, departmentUnavailablePayload('PostgreSQL 未配置，部门统计功能未启用'), { 'Access-Control-Allow-Origin': '*' });
    const range = String(body?.range || 'today').trim();
    if (!DEPARTMENT_RANGES.has(range)) return sendJson(res, 400, { error: { message: '不支持的部门统计范围' } }, { 'Access-Control-Allow-Origin': '*' });
    try {
      const departments = await usageStats.getDepartmentRanking(range);
      const entries = await Promise.all(departments.map(async row => [row.department_id, await usageStats.getDepartmentUsers(row.department_id, range)]));
      const usersByDepartment = Object.fromEntries(entries);
      const labels = { today: '今日排行', yesterday: '昨日排行', month: '本月排行', last_month: '上月排行', total: '总排行' };
      const workbook = buildDepartmentExportWorkbook(labels[range] || '排行', departments, usersByDepartment);
      if (typeof send === 'function') {
        return send(res, 200, workbook, {
          'Access-Control-Allow-Origin': '*',
          'Content-Type': 'application/vnd.ms-excel; charset=utf-8',
          'Content-Disposition': `attachment; filename="department-usage-${range}.xls"`,
        });
      }
      res.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/vnd.ms-excel; charset=utf-8',
        'Content-Disposition': `attachment; filename="department-usage-${range}.xls"`,
      });
      return res.end(workbook);
    } catch (err) {
      console.error('[usage] department export failed:', err);
      return sendJson(res, 500, { error: { message: '导出部门统计失败' } }, { 'Access-Control-Allow-Origin': '*' });
    }
  }

  function routeUsage(req, res) {
    const pathname = String(req.url || '').split('?')[0];
    if (pathname === '/api/usage/rankings') return routeRankings(req, res);
    if (pathname === '/api/usage/personal') return routePersonal(req, res);
    if (pathname === '/api/usage/department/verify') return routeDepartmentVerify(req, res);
    if (pathname === '/api/usage/department/rankings') return routeDepartmentRankings(req, res);
    if (pathname === '/api/usage/department/users') return routeDepartmentUsers(req, res);
    if (pathname === '/api/usage/department/export') return routeDepartmentExport(req, res);
    return sendJson(res, 404, { error: { message: '未找到使用统计接口' } }, { 'Access-Control-Allow-Origin': '*' });
  }

  return { routeUsage };
}

module.exports = { createUsageRoutes, buildDepartmentExportWorkbook, isDepartmentPasswordValid };
