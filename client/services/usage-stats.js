(() => {
  async function parseJson(response) {
    const text = await response.text();
    try { return text ? JSON.parse(text) : null; } catch { return { raw: text }; }
  }

  function errorMessage(payload, fallback) {
    return payload?.error?.message || payload?.message || payload?.raw || fallback;
  }

  async function requestRanking(range = 'today', type = 'user', options = {}) {
    const params = new URLSearchParams({ range, type });
    if (options.projectId !== undefined && options.projectId !== null && options.projectId !== '') params.set('project_id', String(options.projectId));
    const response = await fetch(`/api/usage/rankings?${params.toString()}`, { method: 'GET' });
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

  async function exportRanking(apiKey, range = 'today', type = 'user', options = {}) {
    const response = await fetch('/api/usage/rankings/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey, range, type, project_id: options.projectId ?? null }),
    });
    if (!response.ok) {
      const payload = await parseJson(response);
      throw new Error(errorMessage(payload, '导出排行榜失败'));
    }
    const disposition = response.headers.get('content-disposition') || '';
    const encodedName = disposition.match(/filename\*=UTF-8''([^;]+)/)?.[1];
    const quotedName = disposition.match(/filename="([^"]+)"/)?.[1];
    const filename = encodedName ? decodeURIComponent(encodedName) : quotedName || `usage-${type}-${range}.xls`;
    return { blob: await response.blob(), filename };
  }

  window.ChatUIServices = window.ChatUIServices || {};
  window.ChatUIServices.usageStats = { requestRanking, requestPersonal, exportRanking };
})();
