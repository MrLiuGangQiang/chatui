const { readBody, parseJson } = require('../../http/body');
const usageService = require('../../services/usage.service');
const usageValidator = require('../../validators/usage.validator');

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

function compactTokenRow(row = {}) {
  return [row.username || '', row.total_tokens || 0, row.prompt_tokens || 0, row.completion_tokens || 0, row.prompt_cached_tokens || 0, row.completion_reasoning_tokens || 0];
}

function compactDepartmentRow(row = {}) {
  return [row.department_id || '', row.department_name || '', row.total_tokens || 0, row.prompt_tokens || 0, row.completion_tokens || 0, row.prompt_cached_tokens || 0, row.completion_reasoning_tokens || 0];
}

async function readJsonBody(req, res, sendJson) {
  try {
    return parseJson(await readBody(req, { maxBytes: 256 * 1024 }));
  } catch (err) {
    sendJson(res, err.statusCode || 400, { error: { message: err.message || '请求体不是有效 JSON', code: err.code || 'INVALID_REQUEST_BODY' } }, { 'Access-Control-Allow-Origin': '*' });
    return null;
  }
}

function validateDepartmentAccess(body, res, sendJson) {
  if (!usageValidator.hasDepartmentPassword()) {
    sendJson(res, 200, departmentUnavailablePayload(), { 'Access-Control-Allow-Origin': '*' });
    return false;
  }
  const password = usageValidator.normalizeDepartmentPassword(body);
  if (!usageValidator.isDepartmentPasswordValid(password)) {
    sendJson(res, 403, { available: true, authorized: false, error: { message: '密码错误，无权限访问' } }, { 'Access-Control-Allow-Origin': '*' });
    return false;
  }
  return true;
}

function createUsageController({ sendJson, sendMethodNotAllowed, usageStats, usageAccessValidator, feedbackSender, send }) {
  async function validateUsageAccess(body, res) {
    const apiKey = usageValidator.normalizeApiKey(body);
    const model = String(body?.model || body?.chat_model || '').trim();
    if (!apiKey) {
      sendJson(res, 400, { error: { message: '请先配置有效的 API Key', code: 'INVALID_API_KEY' } }, { 'Access-Control-Allow-Origin': '*' });
      return null;
    }
    if (!model) {
      sendJson(res, 400, { error: { message: '请先正确配置聊天模型', code: 'MODEL_NOT_CONFIGURED' } }, { 'Access-Control-Allow-Origin': '*' });
      return null;
    }
    return { apiKey, model };
  }
  async function routeFeedback(req, res) {
    if (req.method !== 'POST') return sendMethodNotAllowed(res);
    const body = await readJsonBody(req, res, sendJson);
    if (!body) return;
    try {
      const access = await validateUsageAccess(body, res);
      if (!access) return;
      if (!usageStats) return sendJson(res, 503, { error: { message: '统计数据源未配置，无法识别反馈用户名', code: 'USAGE_UNAVAILABLE' } }, { 'Access-Control-Allow-Origin': '*' });
      const personal = await usageService.getPersonalRange(usageStats, access.apiKey, 'total');
      const username = String(personal?.username || '').trim();
      if (!username) return sendJson(res, 403, { error: { message: '未找到该 API Key 对应的统计用户名，无法提交反馈', code: 'INVALID_API_KEY' } }, { 'Access-Control-Allow-Origin': '*' });
      await feedbackSender?.send(body.content, { username });
      return sendJson(res, 200, { ok: true, message: '反馈已发送' }, { 'Access-Control-Allow-Origin': '*' });
    } catch (err) {
      if (err?.code !== 'FEEDBACK_NOT_CONFIGURED') console.error('[feedback] dingtalk delivery failed:', err?.cause?.message || err?.message || err);
      return sendJson(res, err?.statusCode || 500, { error: { message: err?.message || '反馈发送失败，请稍后重试', code: err?.code || 'FEEDBACK_DELIVERY_FAILED' } }, { 'Access-Control-Allow-Origin': '*' });
    }
  }
  async function routeOverview(req, res) {
    if (req.method !== 'POST') return sendMethodNotAllowed(res);
    const body = await readJsonBody(req, res, sendJson);
    if (!body) return;
    const apiKey = usageValidator.normalizeApiKey(body);
    if (!(await validateUsageAccess(body, res))) return;
    const rankingRange = usageValidator.normalizePersonalRange(body?.ranking_range || body?.rankingRange || body?.range);
    const personalRange = usageValidator.normalizePersonalRange(body?.personal_range || body?.personalRange || body?.range);
    if (!rankingRange || !personalRange) return sendJson(res, 400, { error: { message: '不支持的统计范围' } }, { 'Access-Control-Allow-Origin': '*' });
    const limitResult = usageValidator.checkUsageRefreshLimit(req, 'overview');
    if (!limitResult.allowed) {
      return sendJson(res, 200, {
        available: true,
        limited: true,
        message: '请不要频繁刷新，请一分钟后重试',
        ranking: [],
        personal: null,
      }, usageValidator.usageRateLimitHeaders(limitResult));
    }
    if (!usageStats) return sendJson(res, 200, unavailablePayload(), { 'Access-Control-Allow-Origin': '*' });
    try {
      const overview = await usageService.getOverview(usageStats, apiKey, rankingRange, personalRange);
      if (body?.compact) {
        return sendJson(res, 200, {
          ok: 1,
          available: true,
          rr: rankingRange,
          pr: personalRange,
          rows: (overview.ranking || []).map(compactTokenRow),
          personal: overview.personal ? compactTokenRow(overview.personal) : null,
        }, { 'Access-Control-Allow-Origin': '*' });
      }
      return sendJson(res, 200, { available: true, ranking_range: rankingRange, personal_range: personalRange, ...overview }, { 'Access-Control-Allow-Origin': '*' });
    } catch (err) {
      console.error('[usage] overview query failed:', err);
      return sendJson(res, 500, { error: { message: '查询使用统计失败' } }, { 'Access-Control-Allow-Origin': '*' });
    }
  }

  async function routeRankings(req, res) {
    if (req.method !== 'POST') return sendMethodNotAllowed(res);
    const body = await readJsonBody(req, res, sendJson);
    if (!body || !(await validateUsageAccess(body, res))) return;
    const limitResult = usageValidator.checkUsageRefreshLimit(req, 'rankings');
    if (!limitResult.allowed) {
      return sendJson(res, 200, {
        available: true,
        limited: true,
        message: '请不要频繁刷新，请一分钟后重试',
        ranking: [],
      }, usageValidator.usageRateLimitHeaders(limitResult));
    }
    if (!usageStats) return sendJson(res, 200, unavailablePayload(), { 'Access-Control-Allow-Origin': '*' });
    const range = usageValidator.normalizePersonalRange(body?.range);
    if (!range) return sendJson(res, 400, { error: { message: '不支持的排行范围' } }, { 'Access-Control-Allow-Origin': '*' });
    try {
      const ranking = await usageService.getRanking(usageStats, range);
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
    const apiKey = usageValidator.normalizeApiKey(body);
    if (!(await validateUsageAccess(body, res))) return;
    const range = usageValidator.normalizePersonalRange(body?.range);
    if (!range) return sendJson(res, 400, { error: { message: '不支持的统计范围' } }, { 'Access-Control-Allow-Origin': '*' });
    const limitResult = usageValidator.checkUsageRefreshLimit(req, 'personal');
    if (!limitResult.allowed) {
      return sendJson(res, 200, {
        available: true,
        limited: true,
        message: '请不要频繁刷新，请一分钟后重试',
        personal: null,
      }, usageValidator.usageRateLimitHeaders(limitResult));
    }
    if (!usageStats) return sendJson(res, 200, unavailablePayload(), { 'Access-Control-Allow-Origin': '*' });
    try {
      const personal = await usageService.getPersonalRange(usageStats, apiKey, range);
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
    if (!(await validateUsageAccess(body, res))) return;
    if (!usageValidator.hasDepartmentPassword()) return sendJson(res, 200, departmentUnavailablePayload(), { 'Access-Control-Allow-Origin': '*' });
    if (!usageValidator.isDepartmentPasswordValid(String(body?.password || '').trim())) {
      return sendJson(res, 403, { available: true, authorized: false, error: { message: '密码错误，无权限访问' } }, { 'Access-Control-Allow-Origin': '*' });
    }
    return sendJson(res, 200, { available: true, authorized: true }, { 'Access-Control-Allow-Origin': '*' });
  }

  async function routeDepartmentSummary(req, res) {
    if (req.method !== 'POST') return sendMethodNotAllowed(res);
    const body = await readJsonBody(req, res, sendJson);
    if (!body) return;
    if (!(await validateUsageAccess(body, res))) return;
    if (!validateDepartmentAccess(body, res, sendJson)) return;
    if (!usageStats) return sendJson(res, 200, departmentUnavailablePayload('PostgreSQL 未配置，部门统计功能未启用'), { 'Access-Control-Allow-Origin': '*' });
    const range = usageValidator.normalizeDepartmentRange(body?.range);
    if (!range) return sendJson(res, 400, { error: { message: '不支持的部门统计范围' } }, { 'Access-Control-Allow-Origin': '*' });
    try {
      const summary = await usageService.getDepartmentSummary(usageStats, range);
      if (body?.compact) {
        return sendJson(res, 200, {
          ok: 1,
          available: true,
          authorized: true,
          r: range,
          rows: (summary.ranking || []).map(compactDepartmentRow),
        }, { 'Access-Control-Allow-Origin': '*' });
      }
      return sendJson(res, 200, { available: true, authorized: true, range, ...summary }, { 'Access-Control-Allow-Origin': '*' });
    } catch (err) {
      console.error('[usage] department summary query failed:', err);
      return sendJson(res, 500, { error: { message: '查询部门统计失败' } }, { 'Access-Control-Allow-Origin': '*' });
    }
  }


  async function routeDepartmentRankings(req, res) {
    if (req.method !== 'POST') return sendMethodNotAllowed(res);
    const body = await readJsonBody(req, res, sendJson);
    if (!body) return;
    if (!(await validateUsageAccess(body, res))) return;
    if (!validateDepartmentAccess(body, res, sendJson)) return;
    if (!usageStats) return sendJson(res, 200, departmentUnavailablePayload('PostgreSQL 未配置，部门统计功能未启用'), { 'Access-Control-Allow-Origin': '*' });
    const range = usageValidator.normalizeDepartmentRange(body?.range);
    if (!range) return sendJson(res, 400, { error: { message: '不支持的部门统计范围' } }, { 'Access-Control-Allow-Origin': '*' });
    try {
      const ranking = await usageService.getDepartmentRanking(usageStats, range);
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
    if (!(await validateUsageAccess(body, res))) return;
    if (!validateDepartmentAccess(body, res, sendJson)) return;
    if (!usageStats) return sendJson(res, 200, departmentUnavailablePayload('PostgreSQL 未配置，部门统计功能未启用'), { 'Access-Control-Allow-Origin': '*' });
    const range = usageValidator.normalizeDepartmentRange(body?.range);
    const departmentId = usageValidator.normalizeDepartmentId(body);
    if (!range) return sendJson(res, 400, { error: { message: '不支持的部门统计范围' } }, { 'Access-Control-Allow-Origin': '*' });
    if (!departmentId) return sendJson(res, 400, { error: { message: '缺少部门主键' } }, { 'Access-Control-Allow-Origin': '*' });
    try {
      const users = await usageService.getDepartmentUsers(usageStats, departmentId, range);
      if (body?.compact) {
        return sendJson(res, 200, { ok: 1, available: true, r: range, d: departmentId, rows: users.map(compactTokenRow) }, { 'Access-Control-Allow-Origin': '*' });
      }
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
    if (!(await validateUsageAccess(body, res))) return;
    if (!validateDepartmentAccess(body, res, sendJson)) return;
    if (!usageStats) return sendJson(res, 200, departmentUnavailablePayload('PostgreSQL 未配置，部门统计功能未启用'), { 'Access-Control-Allow-Origin': '*' });
    const range = usageValidator.normalizeDepartmentRange(body?.range);
    if (!range) return sendJson(res, 400, { error: { message: '不支持的部门统计范围' } }, { 'Access-Control-Allow-Origin': '*' });
    try {
      const workbook = await usageService.getDepartmentExportWorkbook(usageStats, range);
      if (typeof send === 'function') {
        return send(res, 200, workbook, {
          'Access-Control-Allow-Origin': '*',
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': `attachment; filename="department-usage-${range}.xlsx"`,
        });
      }
      res.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="department-usage-${range}.xlsx"`,
      });
      return res.end(workbook);
    } catch (err) {
      console.error('[usage] department export failed:', err);
      return sendJson(res, 500, { error: { message: '导出部门统计失败' } }, { 'Access-Control-Allow-Origin': '*' });
    }
  }

  return {
    routeOverview,
    routeRankings,
    routePersonal,
    routeDepartmentVerify,
    routeDepartmentSummary,
    routeDepartmentRankings,
    routeDepartmentUsers,
    routeDepartmentExport,
    routeFeedback,
  };
}

module.exports = {
  createUsageController,
  isDepartmentPasswordValid: usageValidator.isDepartmentPasswordValid,
};
