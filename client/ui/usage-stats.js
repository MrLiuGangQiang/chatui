(() => {
  const RANKING_TABS = [
    ['today', '今日排行'],
    ['yesterday', '昨日排行'],
    ['total', '总排行'],
  ];
  const CONFIG_KEY = 'openapi-chat-image-config-v2';

  const $ = id => document.getElementById(id);
  const escapeHtml = value => String(value ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

  function formatTokens(value) {
    const number = Number(value) || 0;
    if (Math.abs(number) >= 100000000) return `${trimUnit(number / 100000000)}B`;
    if (Math.abs(number) >= 1000000) return `${trimUnit(number / 1000000)}M`;
    return new Intl.NumberFormat('zh-CN').format(number);
  }

  function trimUnit(value) {
    return value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1).replace(/\.0$/, '') : value.toFixed(2).replace(/\.0+$/, '').replace(/(\.\d)0$/, '$1');
  }

  function fullNumber(value) {
    return new Intl.NumberFormat('zh-CN').format(Number(value) || 0);
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
            <span id="usageStatsStatus" class="usage-stats-status" aria-live="polite"></span>
          </div>
          <div class="usage-stats-actions">
            <button id="usageStatsRefresh" type="button" title="刷新" aria-label="刷新统计">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 0 1-13.66 5.66"/><path d="M4 12A8 8 0 0 1 17.66 6.34"/><path d="M17 2v5h5"/><path d="M7 22v-5H2"/></svg>
            </button>
            <button id="usageStatsClose" type="button" aria-label="关闭">×</button>
          </div>
        </div>
        <div id="usagePersonal" class="usage-personal"></div>
        <div class="usage-stats-body">
          <div class="usage-tabs" role="tablist">
            ${RANKING_TABS.map(([key, label], index) => `<button type="button" data-usage-tab="${key}" class="${index === 0 ? 'active' : ''}">${label}</button>`).join('')}
          </div>
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
      ['缓存输入', row?.prompt_cached_tokens],
      ['推理输出', row?.completion_reasoning_tokens],
    ];
  }

  function renderPersonal(personal, hasApiKey) {
    const el = $('usagePersonal');
    if (!el) return;
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
          ${RANKING_TABS.map(([key, label]) => `<button type="button" data-personal-range="${key}" class="${key === activePersonalRange ? 'active' : ''}">${label.replace('排行', '')}</button>`).join('')}
        </div>
        <div class="usage-metrics usage-personal-fields">
          ${tokenColumns(row).slice(1).map(([label, value], index) => `<div class="usage-personal-metric usage-personal-metric-${index}" title="${fullNumber(value)}"><span>${label}</span><strong>${formatTokens(value)}</strong></div>`).join('')}
        </div>
      </div>
    `;
    bindPersonalRangeButtons();
  }

  function rangeLabel(range) {
    return RANKING_TABS.find(([key]) => key === range)?.[1]?.replace('排行', '') || '今日';
  }

  function bindPersonalRangeButtons() {
    document.querySelectorAll('[data-personal-range]').forEach(button => {
      button.addEventListener('click', async () => {
        activePersonalRange = button.dataset.personalRange || 'today';
        document.querySelectorAll('[data-personal-range]').forEach(item => item.classList.toggle('active', item === button));
        await loadPersonal(activePersonalRange, { force: false });
      });
    });
  }

  function renderTokenBadges(row) {
    return tokenColumns(row).map(([label, value], index) => `
      <span class="usage-token-badge usage-token-badge-${index}" title="${fullNumber(value)}">
        <em>${label}</em>
        <strong>${formatTokens(value)}</strong>
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

  function renderRanking(rows = [], range = 'today') {
    const el = $('usageRanking');
    if (!el) return;
    const title = RANKING_TABS.find(([key]) => key === range)?.[1] || '排行';
    if (!rows.length) {
      el.innerHTML = `<div class="usage-ranking-title">${title}</div><div class="usage-empty">暂无排行数据。</div>`;
      return;
    }
    el.innerHTML = `
      <div class="usage-ranking-title">${title}</div>
      <div class="usage-ranking-list">
        ${rows.map((row, index) => `
          <div class="usage-ranking-row">
            ${renderRankIndex(index)}
            <span class="usage-ranking-user" title="${escapeHtml(row.username || '-')}">${escapeHtml(row.username || '-')}</span>
            <div class="usage-token-grid">${renderTokenBadges(row)}</div>
          </div>`).join('')}
      </div>`;
  }

  let cache = { rankings: {}, personal: {} };
  let activeRange = 'today';
  let activePersonalRange = 'today';

  function usageService() {
    return window.ChatUIServices?.usageStats;
  }

  async function loadRanking(range, { force = false } = {}) {
    if (!force && cache.rankings[range]) {
      renderRanking(cache.rankings[range], range);
      return;
    }
    const payload = await usageService().requestRanking(range);
    if (!payload.available) {
      cache.rankings[range] = [];
      renderRanking([], range);
      return;
    }
    cache.rankings[range] = payload.ranking || [];
    renderRanking(cache.rankings[range], range);
  }

  async function loadPersonal(range, { force = false } = {}) {
    const apiKey = currentApiKey();
    if (!apiKey) {
      renderPersonal(null, false);
      return;
    }
    if (!force && cache.personal[range]) {
      renderPersonal(cache.personal[range], true);
      return;
    }
    const payload = await usageService().requestPersonal(apiKey, range);
    cache.personal[range] = payload?.personal || null;
    renderPersonal(cache.personal[range], true);
  }

  async function refreshUsageStats() {
    const status = $('usageStatsStatus');
    const refresh = $('usageStatsRefresh');
    status && (status.textContent = '');
    refresh?.classList.add('is-spinning');
    refresh && (refresh.disabled = true);
    try {
      cache.rankings[activeRange] = null;
      cache.personal[activePersonalRange] = null;
      status && (status.textContent = '');
      await Promise.all([
        loadRanking(activeRange, { force: true }),
        loadPersonal(activePersonalRange, { force: true }),
      ]);
    } catch (err) {
      status && (status.textContent = err.message || '加载失败');
    } finally {
      refresh?.classList.remove('is-spinning');
      refresh && (refresh.disabled = false);
    }
  }

  function openPanel() {
    $('usageStatsPanel')?.classList.add('show');
    $('usageStatsPanel')?.setAttribute('aria-hidden', 'false');
    refreshUsageStats();
  }

  function closePanel() {
    $('usageStatsPanel')?.classList.remove('show');
    $('usageStatsPanel')?.setAttribute('aria-hidden', 'true');
  }

  function bind() {
    ensureDom();
    $('usageStatsButton')?.addEventListener('click', openPanel);
    $('usageStatsClose')?.addEventListener('click', closePanel);
    $('usageStatsRefresh')?.addEventListener('click', refreshUsageStats);
    $('usageStatsPanel')?.addEventListener('click', event => {
      if (event.target?.id === 'usageStatsPanel') closePanel();
    });
    document.querySelectorAll('[data-usage-tab]').forEach(button => {
      button.addEventListener('click', async () => {
        activeRange = button.dataset.usageTab || 'today';
        document.querySelectorAll('[data-usage-tab]').forEach(item => item.classList.toggle('active', item === button));
        try {
          await loadRanking(activeRange, { force: false });
        } catch (err) {
          const status = $('usageStatsStatus');
          status && (status.textContent = err.message || '加载失败');
        }
      });
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
})();
