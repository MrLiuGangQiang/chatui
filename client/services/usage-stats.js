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

  window.ChatUIServices = window.ChatUIServices || {};
  window.ChatUIServices.usageStats = { requestRanking, requestPersonal };
})();
