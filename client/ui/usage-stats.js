(() => {
  const format = (typeof window !== 'undefined' && window.ChatUIUsageStatsFormat) || (typeof require === 'function' ? require('./usage-stats-format') : {});
  const auth = (typeof window !== 'undefined' && window.ChatUIUsageStatsAuth) || (typeof require === 'function' ? require('./usage-stats-auth') : {});
  const view = (typeof window !== 'undefined' && window.ChatUIUsageStatsViewHelpers) || (typeof require === 'function' ? require('../features/usage-stats/view-helpers') : {});
  const viewHelpers = typeof view.createUsageStatsViewHelpers === 'function' ? view.createUsageStatsViewHelpers(format) : view;
  const RANKING_TABS = viewHelpers.RANKING_TABS || viewHelpers.DEFAULT_RANKING_TABS || [];
  const DEPARTMENT_TABS = viewHelpers.DEPARTMENT_TABS || viewHelpers.DEFAULT_DEPARTMENT_TABS || [];

  const $ = id => document.getElementById(id);
  const {
    escapeHtml,
    formatTokens,
    fullNumber,
    cachePercent,
    reasoningPercent,
    formatMetricValue,
    fullMetricValue,
  } = format;
  const {
    currentApiKey: readCurrentApiKey,
    shouldLoadRanking,
    getDepartmentPassword,
    setDepartmentPassword,
    clearDepartmentPassword,
  } = auth;

  function currentApiKey() {
    return readCurrentApiKey({ getElement: $ });
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
    return viewHelpers.tokenColumns(row);
  }

  function rawTokenColumns(row) {
    return viewHelpers.rawTokenColumns(row);
  }

  function renderPersonal(personal, hasApiKey) {
    const el = $('usagePersonal');
    if (!el) return;
    if (activeMode === 'department') {
      el.innerHTML = '';
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
    return viewHelpers.rangeLabel(range);
  }

  function tabLabel(range) {
    return viewHelpers.tabLabel(range, activeMode);
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
    return viewHelpers.renderTokenBadges(row, options);
  }

  function renderRankIcon(rank) {
    return viewHelpers.renderRankIcon(rank);
  }

  function renderRankIndex(index) {
    return viewHelpers.renderRankIndex(index);
  }

  function renderTabs() {
    const tabs = activeMode === 'department' ? DEPARTMENT_TABS : RANKING_TABS;
    const selected = activeMode === 'department' ? activeDepartmentRange : activeRange;
    const el = $('usageTabs');
    if (!el) return;
    el.classList.toggle('usage-tabs-department', activeMode === 'department');
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

  function clearDepartmentCache() {
    cache.departmentRankings = {};
    cache.departmentUsers = {};
  }

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
    return viewHelpers.modeToggleIcon(activeMode);
  }

  async function promptAndVerifyDepartmentPassword() {
    const password = String(window.prompt('请输入部门统计访问密码') || '').trim();
    if (!password) return false;
    const payload = await usageService().verifyDepartmentPassword(password);
    if (!payload?.available) throw new Error(payload?.reason || '部门统计未启用');
    if (!payload?.authorized) throw new Error('密码错误，无权限访问');
    setDepartmentPassword(password);
    clearDepartmentCache();
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
      clearDepartmentCache();
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
      if (String(err.message || '').includes('密码错误')) {
        clearDepartmentPassword();
        clearDepartmentCache();
      }
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
    $('usageStatsPanel')?.classList.toggle('usage-mode-department', activeMode === 'department');
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
        if (String(err.message || '').includes('密码错误')) {
          clearDepartmentPassword();
          clearDepartmentCache();
        }
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
          if (String(err.message || '').includes('密码错误')) {
            clearDepartmentPassword();
            clearDepartmentCache();
          }
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
          if (String(err.message || '').includes('密码错误')) {
            clearDepartmentPassword();
            clearDepartmentCache();
          }
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
      link.download = payload.filename || `department-usage-${activeDepartmentRange}.xlsx`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      if (String(err.message || '').includes('密码错误')) {
        clearDepartmentPassword();
        clearDepartmentCache();
      }
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

  if (typeof module !== 'undefined' && module.exports) module.exports = { currentApiKey, renderPersonal, renderRanking, renderDepartmentUsers };

  if (typeof document === 'undefined') return;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
})();
