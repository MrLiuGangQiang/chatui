(() => {
  async function parseJson(response) {
    const text = await response.text();
    try { return text ? JSON.parse(text) : null; } catch { return { raw: text }; }
  }

  function errorMessage(payload, fallback) {
    return payload?.error?.message || payload?.message || payload?.raw || fallback;
  }

  async function requestRanking(range = 'today') {
    const response = await fetch(`/api/usage/rankings?range=${encodeURIComponent(range)}`, { method: 'GET' });
    const payload = await parseJson(response);
    if (!response.ok) throw new Error(errorMessage(payload, '查询使用排行榜失败'));
    return payload;
  }

  async function requestPersonal(apiKey, range = 'today') {
    if (!apiKey) return { available: true, personal: null };
    const response = await fetch('/api/usage/personal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey, range }),
    });
    const payload = await parseJson(response);
    if (!response.ok) throw new Error(errorMessage(payload, '查询个人使用统计失败'));
    return payload;
  }

  async function verifyDepartmentPassword(password) {
    const response = await fetch('/api/usage/department/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const payload = await parseJson(response);
    if (!response.ok) throw new Error(errorMessage(payload, '密码错误，无权限访问'));
    return payload;
  }

  async function requestDepartmentRanking(password, range = 'today') {
    const response = await fetch('/api/usage/department/rankings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password, range }),
    });
    const payload = await parseJson(response);
    if (!response.ok) throw new Error(errorMessage(payload, '查询部门统计失败'));
    return payload;
  }

  async function requestDepartmentUsers(password, departmentId, range = 'today') {
    const response = await fetch('/api/usage/department/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password, department_id: departmentId, range }),
    });
    const payload = await parseJson(response);
    if (!response.ok) throw new Error(errorMessage(payload, '查询部门用户统计失败'));
    return payload;
  }

  async function exportDepartmentUsage(password, range = 'today') {
    const response = await fetch('/api/usage/department/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password, range }),
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
    return { blob, filename: match?.[1] || `department-usage-${range}.xls` };
  }

  window.ChatUIServices = window.ChatUIServices || {};
  window.ChatUIServices.usageStats = {
    requestRanking,
    requestPersonal,
    verifyDepartmentPassword,
    requestDepartmentRanking,
    requestDepartmentUsers,
    exportDepartmentUsage,
  };
})();
