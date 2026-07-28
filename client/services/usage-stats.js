(() => {
  async function parseJson(response) {
    const text = await response.text();
    try { return text ? JSON.parse(text) : null; } catch { return { raw: text }; }
  }

  function errorMessage(payload, fallback) {
    return payload?.error?.message || payload?.message || payload?.raw || fallback;
  }

  function tokenRow(row = []) {
    return {
      username: row[0] || '',
      total_tokens: Number(row[1]) || 0,
      prompt_tokens: Number(row[2]) || 0,
      completion_tokens: Number(row[3]) || 0,
      prompt_cached_tokens: Number(row[4]) || 0,
      completion_reasoning_tokens: Number(row[5]) || 0,
    };
  }

  function departmentRow(row = []) {
    return {
      department_id: row[0] == null ? '' : String(row[0]),
      department_name: row[1] || '',
      total_tokens: Number(row[2]) || 0,
      prompt_tokens: Number(row[3]) || 0,
      completion_tokens: Number(row[4]) || 0,
      prompt_cached_tokens: Number(row[5]) || 0,
      completion_reasoning_tokens: Number(row[6]) || 0,
    };
  }

  function expandOverview(payload) {
    if (!payload?.ok || !Array.isArray(payload.rows)) return payload;
    return { available: true, ranking_range: payload.rr, personal_range: payload.pr, ranking: payload.rows.map(tokenRow), personal: payload.personal ? tokenRow(payload.personal) : null };
  }

  function expandDepartmentSummary(payload) {
    if (!payload?.ok || !Array.isArray(payload.rows)) return payload;
    return { available: true, authorized: payload.authorized !== false, range: payload.r, ranking: payload.rows.map(departmentRow) };
  }

  function expandDepartmentUsers(payload) {
    if (!payload?.ok || !Array.isArray(payload.rows)) return payload;
    return { available: true, range: payload.r, department_id: payload.d, users: payload.rows.map(tokenRow) };
  }

  async function requestRanking(apiKey, model, range = 'today') {
    const response = await fetch('/api/usage/rankings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey || '', model: model || '', range }),
    });
    const payload = await parseJson(response);
    if (!response.ok) throw new Error(errorMessage(payload, '查询使用排行榜失败'));
    return payload;
  }

  async function requestPersonal(apiKey, model, range = 'today') {
    if (!apiKey) return { available: true, personal: null };
    const response = await fetch('/api/usage/personal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey, model, range }),
    });
    const payload = await parseJson(response);
    if (!response.ok) throw new Error(errorMessage(payload, '查询个人使用统计失败'));
    return payload;
  }

  async function requestOverview(apiKey, model, rankingRange = 'today', personalRange = 'today') {
    const response = await fetch('/api/usage/overview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey || '', model: model || '', ranking_range: rankingRange, personal_range: personalRange, compact: true }),
    });
    const payload = await parseJson(response);
    if (!response.ok) throw new Error(errorMessage(payload, '查询使用统计失败'));
    return expandOverview(payload);
  }

  async function verifyDepartmentPassword(password, apiKey, model) {
    const response = await fetch('/api/usage/department/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password, api_key: apiKey || '', model: model || '' }),
    });
    const payload = await parseJson(response);
    if (!response.ok) throw new Error(errorMessage(payload, '密码错误，无权限访问'));
    return payload;
  }

  async function requestDepartmentRanking(password, apiKey, model, range = 'today') {
    const response = await fetch('/api/usage/department/rankings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password, api_key: apiKey || '', model: model || '', range, compact: true }),
    });
    const payload = await parseJson(response);
    if (!response.ok) throw new Error(errorMessage(payload, '查询部门统计失败'));
    return expandDepartmentSummary(payload);
  }

  async function requestDepartmentSummary(password, apiKey, model, range = 'today') {
    const response = await fetch('/api/usage/department/summary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password, api_key: apiKey || '', model: model || '', range, compact: true }),
    });
    const payload = await parseJson(response);
    if (!response.ok) throw new Error(errorMessage(payload, '查询部门统计失败'));
    return expandDepartmentSummary(payload);
  }

  async function requestDepartmentUsers(password, apiKey, model, departmentId, range = 'today') {
    const response = await fetch('/api/usage/department/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password, api_key: apiKey || '', model: model || '', department_id: departmentId, range, compact: true }),
    });
    const payload = await parseJson(response);
    if (!response.ok) throw new Error(errorMessage(payload, '查询部门用户统计失败'));
    return expandDepartmentUsers(payload);
  }

  async function exportDepartmentUsage(password, apiKey, model, range = 'today') {
    const response = await fetch('/api/usage/department/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password, api_key: apiKey || '', model: model || '', range }),
    });
    const contentType = response.headers.get('content-type') || '';
    if (!response.ok || contentType.includes('application/json')) {
      const payload = contentType.includes('application/json') ? await parseJson(response) : { raw: await response.text() };
      if (!response.ok) throw new Error(errorMessage(payload, '导出部门统计失败'));
      if (payload?.available === false) throw new Error(payload.reason || '部门统计不可用');
    }
    const blob = await response.blob();
    const disposition = response.headers.get('content-disposition') || '';
    const match = disposition.match(/filename="?([^";]+)"?/i);
    return { blob, filename: match?.[1] || `department-usage-${range}.xlsx` };
  }

  async function submitFeedback(content, apiKey, model) {
    const response = await fetch('/api/usage/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, api_key: apiKey || '', model: model || '' }),
    });
    const payload = await parseJson(response);
    if (!response.ok) throw new Error(errorMessage(payload, '反馈发送失败，请稍后重试'));
    return payload;
  }

  window.ChatUIServices = window.ChatUIServices || {};
  window.ChatUIServices.usageStats = {
    requestOverview,
    requestRanking,
    requestPersonal,
    verifyDepartmentPassword,
    requestDepartmentSummary,
    requestDepartmentRanking,
    requestDepartmentUsers,
    exportDepartmentUsage,
    submitFeedback,
  };
})();
