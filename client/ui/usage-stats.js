(() => {
  const RANKING_TABS = [
    ['today', '今日排行'],
    ['yesterday', '昨日排行'],
    ['total', '总排行'],
  ];
  const DEPARTMENT_TABS = [
    ['today', '今日排行'],
    ['yesterday', '昨日排行'],
    ['month', '本月排行'],
    ['last_month', '上月排行'],
    ['total', '总排行'],
  ];
  const CONFIG_KEY = 'openapi-chat-image-config-v2';
  const DEPARTMENT_PASSWORD_KEY = 'openapi-chat-usage-department-password';

  const $ = id => document.getElementById(id);
  const escapeHtml = (typeof window !== 'undefined' && (window.ChatUIAppFormatting || window.ChatUIApp?.formatting || {}).escapeHtml) || (value => String(value ?? '').replace(/[&<>"'`]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[ch])));

  function formatTokens(value) {
    const number = Number(value) || 0;
    if (Math.abs(number) >= 1000000000) return `${trimUnit(number / 1000000000)}B`;
    if (Math.abs(number) >= 1000000) return `${trimUnit(number / 1000000)}M`;
    return new Intl.NumberFormat('zh-CN').format(number);
  }

  function trimUnit(value) {
    return value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1).replace(/\.0$/, '') : value.toFixed(2).replace(/\.0+$/, '').replace(/(\.\d)0$/, '$1');
  }

  function fullNumber(value) {
    return new Intl.NumberFormat('zh-CN').format(Number(value) || 0);
  }

  function tokenPercent(part, total) {
    const totalTokens = Number(total) || 0;
    const partTokens = Number(part) || 0;
    if (totalTokens <= 0 || partTokens <= 0) return 0;
    return Math.max(0, Math.min(100, partTokens / totalTokens * 100));
  }

  function cachePercent(row = {}) {
    return tokenPercent(row?.prompt_cached_tokens, row?.prompt_tokens);
  }

  function reasoningPercent(row = {}) {
    return tokenPercent(row?.completion_reasoning_tokens, row?.completion_tokens);
  }

  function formatPercent(value) {
    const number = Number(value) || 0;
    return `${number >= 10 ? number.toFixed(1) : number.toFixed(2)}`.replace(/\.0+$/, '').replace(/(\.\d)0$/, '$1') + '%';
  }

  function formatMetricValue(value, type) {
    return type === 'percent' ? formatPercent(value) : formatTokens(value);
  }

  function fullMetricValue(value, type) {
    return type === 'percent' ? formatPercent(value) : fullNumber(value);
  }

  function currentApiKey() {
    const inputValue = $('apiKey')?.value?.trim();
    if (inputValue) return inputValue;
    try {
      return String(JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}')?.apiKey || '').trim();
    } catch {
      return '';
    }
  }

  function shouldLoadRanking(apiKey) {
    return Boolean(String(apiKey || '').trim());
  }

  function getDepartmentPassword() {
    try { return String(localStorage.getItem(DEPARTMENT_PASSWORD_KEY) || '').trim(); } catch { return ''; }
  }

  function setDepartmentPassword(password) {
    try { localStorage.setItem(DEPARTMENT_PASSWORD_KEY, String(password || '').trim()); } catch {}
  }

  function clearDepartmentPassword() {
    try { localStorage.removeItem(DEPARTMENT_PASSWORD_KEY); } catch {}
  }

  function ensureDom() {
    if ($('usageStatsButton')) return;
    const button = document.createElement('button');
    button.id = 'usageStatsButton';
    button.className = 'usage-stats-button';
    button.type = 'button';
    button.title = '使用统计';
    button.setAttribute('aria-label', '使用统计');
    button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19h16"/><path d="M5 15l4-4 3 3 6-7"/><path d="M15 7h3v3"/></svg>';

    const panel = document.createElement('section');
    panel.id = 'usageStatsPanel';
    panel.className = 'usage-stats-panel';
    panel.setAttribute('aria-hidden', 'true');
    panel.innerHTML = `
      <div class="usage-stats-card" role="dialog" aria-modal="false" aria-labelledby="usageStatsTitle">
        <div class="usage-stats-head">
          <div>
            <strong id="usageStatsTitle">使用统计</strong>
            <span id="usageStatsSubtitle">个人统计</span>
          </div>
          <div class="usage-stats-actions">
            <span id="usageStatsStatus" class="usage-stats-status" aria-live="polite"></span>
            <button id="usageStatsModeToggle" class="usage-mode-toggle" type="button" title="切换部门统计" aria-label="切换部门统计">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16"/><path d="M4 17h16"/><path d="M7 4 4 7l3 3"/><path d="M17 14l3 3-3 3"/></svg>
            </button>
            <button id="usageStatsExport" class="usage-export-button" type="button" title="导出部门统计 Excel" aria-label="导出部门统计 Excel">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v11"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/><path d="M6 17v4"/><path d="M18 17v4"/></svg>
            </button>
            <button id="usageStatsRefresh" type="button" title="刷新" aria-label="刷新统计">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 0 1-13.66 5.66"/><path d="M4 12A8 8 0 0 1 17.66 6.34"/><path d="M17 2v5h5"/><path d="M7 22v-5H2"/></svg>
            </button>
            <button id="usageStatsClose" type="button" aria-label="关闭">×</button>
          </div>
        </div>
        <div id="usagePersonal" class="usage-personal"></div>
        <div class="usage-stats-body">
          <div id="usageTabs" class="usage-tabs" role="tablist"></div>
          <div id="usageRanking" class="usage-ranking"></div>
        </div>
      </div>`;
    document.body.append(button, panel);
  }

  function tokenColumns(row) {
    return [
      ['总用量', row?.total_tokens],
      ['输入', row?.prompt_tokens],
      ['输出', row?.completion_tokens],
      ['缓存输入', cachePercent(row), 'percent'],
      ['推理输出', reasoningPercent(row), 'percent'],
    ];
  }

  function rawTokenColumns(row) {
    return [
      ['总用量', row?.total_tokens],
      ['输入', row?.prompt_tokens],
      ['输出', row?.completion_tokens],
      ['缓存输入', row?.prompt_cached_tokens],
      ['推理输出', row?.completion_reasoning_tokens],
    ];
  }

  function renderPersonal(personal, hasApiKey) {
    const el = $('usagePersonal');
    if (!el) return;
    if (activeMode === 'department') {
      el.innerHTML = '<div class="usage-empty">部门统计已开启。点击部门行可下钻查看人员使用统计。</div>';
      return;
    }
    if (!hasApiKey) {
      el.innerHTML = '<div class="usage-empty">未配置 API Key，无法展示个人统计。</div>';
      return;
    }
    if (!personal) {
      el.innerHTML = '<div class="usage-empty">暂无个人统计数据。</div>';
      bindPersonalRangeButtons();
      return;
    }
    const row = personal;
    el.innerHTML = `
      <div class="usage-personal-total" title="${fullNumber(row.total_tokens)}">
        <div>
          <span>${rangeLabel(activePersonalRange)}总用量</span>
          <strong>${formatTokens(row.total_tokens)}</strong>
        </div>
        <div class="usage-personal-name">${escapeHtml(row.username || '当前 API Key')}</div>
      </div>
      <div class="usage-personal-side">
        <div class="usage-personal-ranges">
          ${RANKING_TABS.map(([key]) => `<button type="button" data-personal-range="${key}" class="${key === activePersonalRange ? 'active' : ''}">${rangeLabel(key)}</button>`).join('')}
        </div>
        <div class="usage-metrics usage-personal-fields">
          ${tokenColumns(row).slice(1).map(([label, value, type], index) => `<div class="usage-personal-metric usage-personal-metric-${index}" title="${fullMetricValue(value, type)}"><span>${label}</span><strong>${formatMetricValue(value, type)}</strong></div>`).join('')}
        </div>
      </div>
    `;
    bindPersonalRangeButtons();
  }

  function rangeLabel(range) {
    if (range === 'total') return '所有时间';
    if (range === 'month') return '本月';
    if (range === 'last_month') return '上月';
    return [...RANKING_TABS, ...DEPARTMENT_TABS].find(([key]) => key === range)?.[1]?.replace('排行', '') || '今日';
  }

  function tabLabel(range) {
    return (activeMode === 'department' ? DEPARTMENT_TABS : RANKING_TABS).find(([key]) => key === range)?.[1] || '排行';
  }

  function bindPersonalRangeButtons() {
    document.querySelectorAll('[data-personal-range]').forEach(button => {
      button.addEventListener('click', async () => {
        activePersonalRange = button.dataset.personalRange || 'today';
        document.querySelectorAll('[data-personal-range]').forEach(item => item.classList.toggle('active', item === button));
        try {
          clearUsageLimit();
          await loadPersonal(activePersonalRange);
        } catch (err) {
          showUsageLimit(err.message || '加载失败');
        }
      });
    });
  }

  function renderTokenBadges(row, options = {}) {
    const columns = options.raw ? rawTokenColumns(row) : tokenColumns(row);
    return columns.map(([label, value, type], index) => `
      <span class="usage-token-badge usage-token-badge-${index}" title="${fullMetricValue(value, type)}">
        <em>${label}</em>
        <strong>${formatMetricValue(value, type)}</strong>
      </span>`).join('');
  }

  function renderRankIcon(rank) {
    if (rank === 1) return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4h10l-1.2 6.6A4.8 4.8 0 0 1 12 14a4.8 4.8 0 0 1-3.8-3.4L7 4Z"/><path d="M8.5 5.8H4.8c.2 3.4 1.7 5.2 4.4 5.7"/><path d="M15.5 5.8h3.7c-.2 3.4-1.7 5.2-4.4 5.7"/><path d="M10.4 14h3.2v3.2h-3.2z"/><path d="M7.8 20h8.4"/></svg>';
    if (rank === 2) return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.2 14.7 8l5.3 1-3.7 3.9.7 5.4-5-2.3-5 2.3.7-5.4L4 9l5.3-1L12 3.2Z"/><path d="M9.7 10.4a2.3 2.3 0 1 1 4.6 0c0 1.7-2.1 2.4-4.4 4.3h4.7"/></svg>';
    if (rank === 3) return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 4.8h11l-1.1 7.4a4.5 4.5 0 0 1-8.8 0L6.5 4.8Z"/><path d="M9.3 10.2h3a1.7 1.7 0 0 1 0 3.4H9.4"/><path d="M12 13.6a1.7 1.7 0 1 1 0 3.4H9.2"/><path d="M10 18.6h4"/></svg>';
    return `<span>${rank}</span>`;
  }

  function renderRankIndex(index) {
    const rank = index + 1;
    if (rank <= 3) return `<div class="usage-rank-index usage-rank-medal usage-rank-medal-${rank}" aria-label="第 ${rank} 名"><span class="usage-rank-num">${rank}</span>${renderRankIcon(rank)}</div>`;
    return `<div class="usage-rank-index">${renderRankIcon(rank)}</div>`;
  }

  function renderTabs() {
    const tabs = activeMode === 'department' ? DEPARTMENT_TABS : RANKING_TABS;
    const selected = activeMode === 'department' ? activeDepartmentRange : activeRange;
    const el = $('usageTabs');
    if (!el) return;
    el.classList.toggle('usage-tabs-five', activeMode === 'department');
    el.innerHTML = tabs.map(([key, label]) => `<button type="button" data-usage-tab="${key}" class="${key === selected ? 'active' : ''}">${label}</button>`).join('');
    bindTabs();
  }

  function renderRanking(rows = [], range = 'today') {
    const el = $('usageRanking');
    if (!el) return;
    const title = tabLabel(range);
    if (!rows.length) {
      el.innerHTML = `<div class="usage-ranking-title">${title}</div><div class="usage-empty">暂无排行数据。</div>`;
      return;
    }
    el.innerHTML = `
      <div class="usage-ranking-title">${title}</div>
      <div class="usage-ranking-list">
        ${rows.map((row, index) => {
          const name = activeMode === 'department' ? (row.department_name || '-') : (row.username || '-');
          const deptAttrs = activeMode === 'department' ? ` role="button" tabindex="0" data-department-id="${escapeHtml(row.department_id)}" data-department-name="${escapeHtml(name)}"` : '';
          return `
          <div class="usage-ranking-row${activeMode === 'department' ? ' usage-department-row' : ''}"${deptAttrs}>
            ${renderRankIndex(index)}
            <span class="usage-ranking-user" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
            <div class="usage-token-grid">${renderTokenBadges(row, { raw: activeMode === 'department' })}</div>
          </div>`;
        }).join('')}
      </div>`;
    bindDepartmentRows();
  }

  function renderDepartmentUsers(departmentName, rows = []) {
    const el = $('usageRanking');
    if (!el) return;
    el.innerHTML = `
      <div class="usage-ranking-title usage-drill-title"><button type="button" id="usageBackDepartments">← 部门排行</button><span>${escapeHtml(departmentName)} · ${tabLabel(activeDepartmentRange)}人员统计</span></div>
      ${rows.length ? `<div class="usage-ranking-list">${rows.map((row, index) => `
        <div class="usage-ranking-row">
          ${renderRankIndex(index)}
          <span class="usage-ranking-user" title="${escapeHtml(row.username || '-')}">${escapeHtml(row.username || '-')}</span>
          <div class="usage-token-grid">${renderTokenBadges(row, { raw: true })}</div>
        </div>`).join('')}</div>` : '<div class="usage-empty">暂无人员统计数据。</div>'}`;
    $('usageBackDepartments')?.addEventListener('click', () => renderRanking(cache.departmentRankings[activeDepartmentRange] || [], activeDepartmentRange));
  }

  let cache = { rankings: {}, personal: {}, departmentRankings: {}, departmentUsers: {} };
  let activeRange = 'today';
  let activePersonalRange = 'today';
  let activeDepartmentRange = 'today';
  let activeMode = 'personal';

  function usageService() {
    return window.ChatUIServices?.usageStats;
  }

  function showUsageLimit(message) {
    const status = $('usageStatsStatus');
    if (!status) return;
    status.innerHTML = `<span class="usage-stats-warning-icon" aria-hidden="true">⚠️</span><span>${escapeHtml(message || '请不要频繁刷新，请一分钟后重试')}</span>`;
    status.classList.add('is-warning');
  }

  function clearUsageLimit() {
    const status = $('usageStatsStatus');
    if (!status) return;
    status.textContent = '';
    status.classList.remove('is-warning');
  }

  function modeToggleIcon() {
    if (activeMode === 'department') {
      return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z"/><path d="M4.5 21a7.5 7.5 0 0 1 15 0"/></svg>';
    }
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 21h18"/><path d="M5 21V7l7-4 7 4v14"/><path d="M9 21v-6h6v6"/><path d="M9 10h.01"/><path d="M15 10h.01"/></svg>';
  }

  async function promptAndVerifyDepartmentPassword() {
    const password = String(window.prompt('请输入部门统计访问密码') || '').trim();
    if (!password) return false;
    const payload = await usageService().verifyDepartmentPassword(password);
    if (!payload?.available) throw new Error(payload?.reason || '部门统计未启用');
    if (!payload?.authorized) throw new Error('密码错误，无权限访问');
    setDepartmentPassword(password);
    return true;
  }

  async function ensureDepartmentAccess() {
    const savedPassword = getDepartmentPassword();
    if (savedPassword) {
      try {
        const payload = await usageService().verifyDepartmentPassword(savedPassword);
        if (!payload?.available) throw new Error(payload?.reason || '部门统计未启用');
        if (payload?.authorized) return true;
      } catch (err) {
        if (!String(err.message || '').includes('密码错误')) throw err;
      }
      clearDepartmentPassword();
      showUsageLimit('已保存的部门统计密码无效，请重新输入');
    }
    return promptAndVerifyDepartmentPassword();
  }

  async function loadRanking(range) {
    if (!shouldLoadRanking(currentApiKey())) {
      cache.rankings[range] = [];
      renderRanking([], range);
      return;
    }
    const payload = await usageService().requestRanking(range);
    if (payload.limited) {
      showUsageLimit(payload.message);
      renderRanking(cache.rankings[range] || [], range);
      return;
    }
    if (!payload.available) {
      cache.rankings[range] = [];
      renderRanking([], range);
      return;
    }
    cache.rankings[range] = payload.ranking || [];
    renderRanking(cache.rankings[range], range);
  }

  async function loadPersonal(range) {
    const apiKey = currentApiKey();
    if (!apiKey) {
      renderPersonal(null, false);
      return;
    }
    const payload = await usageService().requestPersonal(apiKey, range);
    if (payload.limited) {
      showUsageLimit(payload.message);
      renderPersonal(cache.personal[range] || null, true);
      return;
    }
    cache.personal[range] = payload?.personal || null;
    renderPersonal(cache.personal[range], true);
  }

  async function loadDepartmentRanking(range) {
    const password = getDepartmentPassword();
    const payload = await usageService().requestDepartmentRanking(password, range);
    if (payload.limited) {
      showUsageLimit(payload.message);
      renderRanking(cache.departmentRankings[range] || [], range);
      return;
    }
    if (!payload.available) {
      cache.departmentRankings[range] = [];
      renderRanking([], range);
      showUsageLimit(payload.reason || '部门统计不可用');
      return;
    }
    cache.departmentRankings[range] = payload.ranking || [];
    renderRanking(cache.departmentRankings[range], range);
  }

  async function loadDepartmentUsers(departmentId, departmentName) {
    const cacheKey = `${activeDepartmentRange}:${departmentId}`;
    if (cache.departmentUsers[cacheKey]) {
      renderDepartmentUsers(departmentName, cache.departmentUsers[cacheKey]);
      return;
    }
    const payload = await usageService().requestDepartmentUsers(getDepartmentPassword(), departmentId, activeDepartmentRange);
    if (payload.limited) {
      showUsageLimit(payload.message);
      renderDepartmentUsers(departmentName, cache.departmentUsers[cacheKey] || []);
      return;
    }
    cache.departmentUsers[cacheKey] = payload.users || [];
    renderDepartmentUsers(departmentName, cache.departmentUsers[cacheKey]);
  }

  async function refreshUsageStats() {
    const refresh = $('usageStatsRefresh');
    clearUsageLimit();
    refresh?.classList.add('is-spinning');
    refresh && (refresh.disabled = true);
    try {
      if (activeMode === 'department') {
        await loadDepartmentRanking(activeDepartmentRange);
      } else {
        await Promise.all([
          loadRanking(activeRange),
          loadPersonal(activePersonalRange),
        ]);
      }
    } catch (err) {
      if (String(err.message || '').includes('密码错误')) clearDepartmentPassword();
      showUsageLimit(err.message || '加载失败');
    } finally {
      refresh?.classList.remove('is-spinning');
      refresh && (refresh.disabled = false);
    }
  }

  function updateModeUi() {
    $('usageStatsTitle') && ($('usageStatsTitle').textContent = activeMode === 'department' ? '部门统计' : '使用统计');
    $('usageStatsSubtitle') && ($('usageStatsSubtitle').textContent = activeMode === 'department' ? '部门统计' : '个人统计');
    if ($('usageStatsModeToggle')) {
      $('usageStatsModeToggle').innerHTML = modeToggleIcon();
      $('usageStatsModeToggle').title = activeMode === 'department' ? '切换个人统计' : '切换部门统计';
      $('usageStatsModeToggle').setAttribute('aria-label', activeMode === 'department' ? '切换个人统计' : '切换部门统计');
    }
    $('usageStatsExport')?.classList.toggle('show', activeMode === 'department');
    $('usagePersonal')?.classList.toggle('usage-department-summary', activeMode === 'department');
    renderTabs();
  }

  async function switchMode() {
    clearUsageLimit();
    if (activeMode === 'personal') {
      try {
        const ok = await ensureDepartmentAccess();
        if (!ok) return;
        activeMode = 'department';
        updateModeUi();
        renderPersonal(null, true);
        await loadDepartmentRanking(activeDepartmentRange);
      } catch (err) {
        if (String(err.message || '').includes('密码错误')) clearDepartmentPassword();
        showUsageLimit(err.message || '密码错误，无权限访问');
      }
      return;
    }
    activeMode = 'personal';
    updateModeUi();
    await refreshUsageStats();
  }

  function bindDepartmentRows() {
    document.querySelectorAll('[data-department-id]').forEach(row => {
      const open = async () => {
        try {
          clearUsageLimit();
          await loadDepartmentUsers(row.dataset.departmentId, row.dataset.departmentName || '部门');
        } catch (err) {
          if (String(err.message || '').includes('密码错误')) clearDepartmentPassword();
          showUsageLimit(err.message || '查询部门用户统计失败');
        }
      };
      row.addEventListener('click', open);
      row.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          open();
        }
      });
    });
  }

  function bindTabs() {
    document.querySelectorAll('[data-usage-tab]').forEach(button => {
      button.addEventListener('click', async () => {
        if (activeMode === 'department') activeDepartmentRange = button.dataset.usageTab || 'today';
        else activeRange = button.dataset.usageTab || 'today';
        document.querySelectorAll('[data-usage-tab]').forEach(item => item.classList.toggle('active', item === button));
        try {
          clearUsageLimit();
          if (activeMode === 'department') await loadDepartmentRanking(activeDepartmentRange);
          else await loadRanking(activeRange);
        } catch (err) {
          if (String(err.message || '').includes('密码错误')) clearDepartmentPassword();
          showUsageLimit(err.message || '加载失败');
        }
      });
    });
  }

  async function exportDepartmentUsage() {
    try {
      clearUsageLimit();
      const payload = await usageService().exportDepartmentUsage(getDepartmentPassword(), activeDepartmentRange);
      const url = URL.createObjectURL(payload.blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = payload.filename || `department-usage-${activeDepartmentRange}.xls`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      if (String(err.message || '').includes('密码错误')) clearDepartmentPassword();
      showUsageLimit(err.message || '导出部门统计失败');
    }
  }

  function openPanel() {
    $('usageStatsPanel')?.classList.add('show');
    $('usageStatsPanel')?.setAttribute('aria-hidden', 'false');
    updateModeUi();
    refreshUsageStats();
  }

  function closePanel() {
    $('usageStatsPanel')?.classList.remove('show');
    $('usageStatsPanel')?.setAttribute('aria-hidden', 'true');
  }

  function bind() {
    ensureDom();
    updateModeUi();
    $('usageStatsButton')?.addEventListener('click', openPanel);
    $('usageStatsClose')?.addEventListener('click', closePanel);
    $('usageStatsRefresh')?.addEventListener('click', refreshUsageStats);
    $('usageStatsModeToggle')?.addEventListener('click', switchMode);
    $('usageStatsExport')?.addEventListener('click', exportDepartmentUsage);
    $('usageStatsPanel')?.addEventListener('click', event => {
      if (event.target?.id === 'usageStatsPanel') closePanel();
    });
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { formatTokens, trimUnit, fullNumber, tokenPercent, cachePercent, reasoningPercent, formatPercent, shouldLoadRanking };

  if (typeof document === 'undefined') return;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
})();
